"""
camera_tracker.py — 玄枢 摄像头姿态追踪服务 v2.0 (Holistic)

升级到 MediaPipe Holistic：543 关键点（33 身体 + 468 面部 + 21 左手 + 21 右手）。
通过 stdin/stdout JSON 协议与 Node.js 主进程通信。

协议：
  输入 (stdin):  JSON 命令  {"cmd": "start"|"stop"|"gesture_list"|"exit"}
  输出 (stdout): JSON 帧数据 {"ts": ..., "pose_landmarks": [...], "face_landmarks": [...], "left_hand_landmarks": [...], "right_hand_landmarks": [...], "gesture": "wave", "confidence": 0.95}

手势识别（增强版）：
  - wave_right / wave_left: 挥手
  - nod / shake_head: 点头/摇头
  - thumbs_up / thumbs_down: 点赞/踩
  - cross_arms: 抱臂
  - point_right / point_left: 指向
  - bow: 鞠躬
  - ok_sign / peace_sign / fist: OK/剪刀手/握拳
  - idle: 静止
  - not_found: 未检测到人
"""

import sys
import json
import time
import traceback
import math
import select
from collections import Counter
from typing import Optional

import cv2
import numpy as np
import mediapipe as mp

# ============================================================
# 配置
# ============================================================

CAMERA_INDEX = 0
FRAME_WIDTH = 640
FRAME_HEIGHT = 480
MIN_DETECTION_CONFIDENCE = 0.5
MIN_TRACKING_CONFIDENCE = 0.5
GESTURE_HISTORY_SIZE = 5

# ============================================================
# 手势识别器（增强版 — 支持手指级手势）
# ============================================================

class GestureRecognizer:
    """从 MediaPipe Holistic landmarks 识别手势"""

    # Pose
    NOSE = 0
    LEFT_SHOULDER = 11
    RIGHT_SHOULDER = 12
    LEFT_ELBOW = 13
    RIGHT_ELBOW = 14
    LEFT_WRIST = 15
    RIGHT_WRIST = 16
    LEFT_INDEX = 19
    RIGHT_INDEX = 20
    LEFT_THUMB = 21
    RIGHT_THUMB = 22
    LEFT_HIP = 23
    RIGHT_HIP = 24

    # Hand
    WRIST = 0
    THUMB_CMC = 1
    THUMB_TIP = 4
    INDEX_TIP = 8
    MIDDLE_TIP = 12
    RING_TIP = 16
    PINKY_TIP = 20

    def __init__(self):
        self.history: list[str] = []
        self.prev_pose: Optional[dict] = None

    def _get_pose_lm(self, landmarks, idx):
        if landmarks and idx < len(landmarks.landmark):
            lm = landmarks.landmark[idx]
            return {'x': lm.x, 'y': lm.y, 'z': lm.z, 'visibility': lm.visibility}
        return None

    def _get_hand_lm(self, hand_landmarks, idx):
        if hand_landmarks and idx < len(hand_landmarks.landmark):
            lm = hand_landmarks.landmark[idx]
            return {'x': lm.x, 'y': lm.y, 'z': lm.z}
        return None

    def _angle_between(self, a, b, c):
        ba = (a['x'] - b['x'], a['y'] - b['y'])
        bc = (c['x'] - b['x'], c['y'] - b['y'])
        dot = ba[0] * bc[0] + ba[1] * bc[1]
        mag_ba = math.sqrt(ba[0]**2 + ba[1]**2)
        mag_bc = math.sqrt(bc[0]**2 + bc[1]**2)
        if mag_ba < 1e-6 or mag_bc < 1e-6:
            return 0
        cos_val = max(-1, min(1, dot / (mag_ba * mag_bc)))
        return math.degrees(math.acos(cos_val))

    def _distance(self, a, b):
        return math.sqrt((a['x'] - b['x'])**2 + (a['y'] - b['y'])**2)

    def _is_finger_extended(self, hand_lms, tip_idx, pip_idx, mcp_idx):
        """判断手指是否伸直"""
        tip = self._get_hand_lm(hand_lms, tip_idx)
        pip = self._get_hand_lm(hand_lms, pip_idx)
        mcp = self._get_hand_lm(hand_lms, mcp_idx)
        if not all([tip, pip, mcp]):
            return False
        return tip['y'] < pip['y'] < mcp['y']  # 指尖在上

    def classify(self, pose_landmarks, left_hand, right_hand) -> tuple[str, float]:
        """分类当前姿态为手势"""
        if not pose_landmarks:
            return ('not_found', 0.0)

        lm = [self._get_pose_lm(pose_landmarks, i) for i in range(33)]
        nose = lm[self.NOSE]
        l_shoulder = lm[self.LEFT_SHOULDER]
        r_shoulder = lm[self.RIGHT_SHOULDER]
        l_elbow = lm[self.LEFT_ELBOW]
        r_elbow = lm[self.RIGHT_ELBOW]
        l_wrist = lm[self.LEFT_WRIST]
        r_wrist = lm[self.RIGHT_WRIST]
        l_hip = lm[self.LEFT_HIP]
        r_hip = lm[self.RIGHT_HIP]
        l_index = lm[self.LEFT_INDEX]
        r_index = lm[self.RIGHT_INDEX]

        if not all([nose, l_shoulder, r_shoulder]):
            return ('not_found', 0.0)

        shoulder_vis = (l_shoulder['visibility'] + r_shoulder['visibility']) / 2
        if shoulder_vis < 0.5:
            return ('not_found', 0.0)

        # ---- 手指级手势（优先检测，置信度更高）----

        # OK 手势 (右手)
        if right_hand:
            thumb_tip = self._get_hand_lm(right_hand, self.THUMB_TIP)
            index_tip = self._get_hand_lm(right_hand, self.INDEX_TIP)
            mid_tip = self._get_hand_lm(right_hand, self.MIDDLE_TIP)
            ring_tip = self._get_hand_lm(right_hand, self.RING_TIP)
            pinky_tip = self._get_hand_lm(right_hand, self.PINKY_TIP)
            if thumb_tip and index_tip and mid_tip and ring_tip and pinky_tip:
                thumb_idx_dist = self._distance(thumb_tip, index_tip)
                if thumb_idx_dist < 0.05 and mid_tip['y'] < ring_tip['y']:
                    return ('ok_sign', 0.90)

        # 剪刀手 (右手)
        if right_hand:
            index_tip = self._get_hand_lm(right_hand, self.INDEX_TIP)
            mid_tip = self._get_hand_lm(right_hand, self.MIDDLE_TIP)
            ring_tip = self._get_hand_lm(right_hand, self.RING_TIP)
            pinky_tip = self._get_hand_lm(right_hand, self.PINKY_TIP)
            wrist = self._get_hand_lm(right_hand, self.WRIST)
            if all([index_tip, mid_tip, ring_tip, pinky_tip, wrist]):
                index_up = index_tip['y'] < wrist['y'] - 0.05
                mid_up = mid_tip['y'] < wrist['y'] - 0.05
                ring_down = ring_tip['y'] > wrist['y']
                pinky_down = pinky_tip['y'] > wrist['y']
                if index_up and mid_up and ring_down and pinky_down:
                    return ('peace_sign', 0.88)

        # 握拳 (右手)
        if right_hand:
            tips = [self._get_hand_lm(right_hand, i) for i in [4, 8, 12, 16, 20]]
            wrist = self._get_hand_lm(right_hand, self.WRIST)
            if all(tips) and wrist:
                all_below = all(t['y'] > wrist['y'] - 0.02 for t in tips)
                if all_below:
                    return ('fist', 0.85)

        # ---- 身体级手势 ----

        # 1. 挥手 (右手)
        if r_wrist and r_shoulder and r_elbow and r_wrist['visibility'] > 0.5:
            wrist_above_shoulder = r_wrist['y'] < r_shoulder['y'] - 0.05
            wrist_outside = r_wrist['x'] > r_shoulder['x'] + 0.1
            elbow_angle = self._angle_between(r_shoulder, r_elbow, r_wrist)
            if wrist_above_shoulder and wrist_outside and elbow_angle > 60:
                return ('wave_right', 0.85)

        # 2. 挥手 (左手)
        if l_wrist and l_shoulder and l_elbow and l_wrist['visibility'] > 0.5:
            wrist_above_shoulder = l_wrist['y'] < l_shoulder['y'] - 0.05
            wrist_outside = l_wrist['x'] < l_shoulder['x'] - 0.1
            elbow_angle = self._angle_between(l_shoulder, l_elbow, l_wrist)
            if wrist_above_shoulder and wrist_outside and elbow_angle > 60:
                return ('wave_left', 0.85)

        # 3. 点赞
        if r_wrist and r_shoulder and r_wrist['visibility'] > 0.5:
            wrist_above_shoulder_high = r_wrist['y'] < r_shoulder['y'] - 0.12
            wrist_near_center = abs(r_wrist['x'] - r_shoulder['x']) < 0.15
            if wrist_above_shoulder_high and wrist_near_center:
                return ('thumbs_up', 0.80)

        # 4. 抱臂
        if l_wrist and r_wrist and l_elbow and r_elbow:
            wrists_close = self._distance(l_wrist, r_wrist) < 0.2
            wrists_below_shoulder = l_wrist['y'] > l_shoulder['y'] and r_wrist['y'] > r_shoulder['y']
            if wrists_close and wrists_below_shoulder:
                return ('cross_arms', 0.75)

        # 5. 指向 (右手)
        if r_wrist and r_elbow and r_shoulder and r_wrist['visibility'] > 0.5:
            wrist_forward = r_wrist['x'] > r_shoulder['x'] + 0.15
            arm_extended = self._angle_between(r_shoulder, r_elbow, r_wrist) > 120
            if wrist_forward and arm_extended:
                return ('point_right', 0.80)

        # 6. 指向 (左手)
        if l_wrist and l_elbow and l_shoulder and l_wrist['visibility'] > 0.5:
            wrist_forward = l_wrist['x'] < l_shoulder['x'] - 0.15
            arm_extended = self._angle_between(l_shoulder, l_elbow, l_wrist) > 120
            if wrist_forward and arm_extended:
                return ('point_left', 0.80)

        # 7. 点头
        if self.prev_pose and nose:
            prev_nose = self.prev_pose.get('nose_y', nose['y'])
            nose_moved_down = nose['y'] - prev_nose > 0.008
            if nose_moved_down:
                self.prev_pose['nose_y'] = nose['y']
                return ('nod', 0.70)

        # 8. 鞠躬
        if l_hip and r_hip and nose:
            hip_y = (l_hip['y'] + r_hip['y']) / 2
            if nose['y'] > hip_y - 0.05:
                return ('bow', 0.75)

        self.prev_pose = {'nose_y': nose['y']} if nose else {}
        return ('idle', 0.60)

    def smooth(self, gesture: str) -> str:
        self.history.append(gesture)
        if len(self.history) > GESTURE_HISTORY_SIZE:
            self.history.pop(0)
        return Counter(self.history).most_common(1)[0][0]


# ============================================================
# MediaPipe Holistic 追踪器
# ============================================================

class CameraTracker:
    def __init__(self):
        self.running = False
        self.cap: Optional[cv2.VideoCapture] = None
        self.holistic: Optional[mp.solutions.holistic.Holistic] = None
        self.recognizer = GestureRecognizer()

    def start(self):
        try:
            self.cap = cv2.VideoCapture(CAMERA_INDEX)
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, FRAME_WIDTH)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_HEIGHT)

            if not self.cap.isOpened():
                self._send_error('无法打开摄像头')
                return False

            self.holistic = mp.solutions.holistic.Holistic(
                static_image_mode=False,
                model_complexity=1,  # 0=快, 1=平衡, 2=准
                smooth_landmarks=True,
                enable_segmentation=False,
                refine_face_landmarks=True,  # 唇/眼细节
                min_detection_confidence=MIN_DETECTION_CONFIDENCE,
                min_tracking_confidence=MIN_TRACKING_CONFIDENCE,
            )

            self.running = True
            self._send_status('started')
            self._run_loop()
            return True
        except Exception as e:
            self._send_error(f'启动失败: {e}')
            traceback.print_exc(file=sys.stderr)
            return False

    def stop(self):
        self.running = False
        if self.cap:
            self.cap.release()
            self.cap = None
        if self.holistic:
            self.holistic.close()
            self.holistic = None
        self._send_status('stopped')

    def _serialize_landmarks(self, landmark_list) -> list:
        """序列化关键点列表"""
        if not landmark_list:
            return []
        return [
            {'x': round(lm.x, 4), 'y': round(lm.y, 4), 'z': round(lm.z, 4)}
            for lm in landmark_list.landmark
        ]

    def _serialize_pose_landmarks(self, landmark_list) -> list:
        """序列化姿态关键点（含 visibility）"""
        if not landmark_list:
            return []
        return [
            {
                'x': round(lm.x, 4),
                'y': round(lm.y, 4),
                'z': round(lm.z, 4),
                'visibility': round(lm.visibility, 4),
            }
            for lm in landmark_list.landmark
        ]

    def _run_loop(self):
        frame_count = 0
        detect_interval = 2

        while self.running and self.cap and self.cap.isOpened():
            if self._check_stdin():
                break

            ret, frame = self.cap.read()
            if not ret:
                time.sleep(0.1)
                continue

            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            frame_rgb.flags.writeable = False

            results = self.holistic.process(frame_rgb)

            frame_count += 1

            if results.pose_landmarks:
                # 序列化各部位
                pose_lms = self._serialize_pose_landmarks(results.pose_landmarks)
                face_lms = self._serialize_landmarks(results.face_landmarks)
                left_hand = self._serialize_landmarks(results.left_hand_landmarks)
                right_hand = self._serialize_landmarks(results.right_hand_landmarks)

                # 手势识别
                gesture = 'idle'
                confidence = 0.0
                if frame_count % detect_interval == 0:
                    gesture, confidence = self.recognizer.classify(
                        results.pose_landmarks,
                        results.right_hand_landmarks,
                        results.left_hand_landmarks
                    )
                    gesture = self.recognizer.smooth(gesture)
                else:
                    gesture = self.recognizer.history[-1] if self.recognizer.history else 'idle'
                    confidence = 0.5

                self._send_frame(pose_lms, face_lms, left_hand, right_hand, gesture, confidence)
            else:
                self._send_frame([], [], [], [], 'not_found', 0.0)

            time.sleep(0.066)

    def _check_stdin(self) -> bool:
        if select.select([sys.stdin], [], [], 0)[0]:
            line = sys.stdin.readline().strip()
            if line:
                try:
                    cmd = json.loads(line)
                    if cmd.get('cmd') == 'stop':
                        self.stop()
                        return True
                    elif cmd.get('cmd') == 'exit':
                        self.stop()
                        sys.exit(0)
                except json.JSONDecodeError:
                    pass
        return False

    def _send_frame(self, pose_lms, face_lms, left_hand, right_hand, gesture, confidence):
        data = {
            'ts': int(time.time() * 1000),
            'pose_landmarks': pose_lms,
            'face_landmarks': face_lms,
            'left_hand_landmarks': left_hand,
            'right_hand_landmarks': right_hand,
            'gesture': gesture,
            'confidence': round(confidence, 4),
        }
        sys.stdout.write(json.dumps(data) + '\n')
        sys.stdout.flush()

    def _send_status(self, status: str):
        sys.stdout.write(json.dumps({'ts': int(time.time() * 1000), 'status': status}) + '\n')
        sys.stdout.flush()

    def _send_error(self, message: str):
        sys.stdout.write(json.dumps({'ts': int(time.time() * 1000), 'error': message}) + '\n')
        sys.stdout.flush()

    def list_gestures(self):
        gestures = [
            {'id': 'wave_right', 'label': '右手挥手', 'action': 'wave'},
            {'id': 'wave_left', 'label': '左手挥手', 'action': 'wave'},
            {'id': 'nod', 'label': '点头', 'action': 'nod'},
            {'id': 'shake_head', 'label': '摇头', 'action': 'shake_head'},
            {'id': 'thumbs_up', 'label': '点赞', 'action': 'thumbs_up'},
            {'id': 'thumbs_down', 'label': '踩', 'action': 'thumbs_down'},
            {'id': 'cross_arms', 'label': '抱臂', 'action': 'cross_arms'},
            {'id': 'point_right', 'label': '右手指向', 'action': 'point'},
            {'id': 'point_left', 'label': '左手指向', 'action': 'point'},
            {'id': 'bow', 'label': '鞠躬', 'action': 'bow'},
            {'id': 'ok_sign', 'label': 'OK手势', 'action': 'ok'},
            {'id': 'peace_sign', 'label': '剪刀手', 'action': 'peace'},
            {'id': 'fist', 'label': '握拳', 'action': 'fist'},
            {'id': 'idle', 'label': '静止', 'action': 'idle'},
            {'id': 'not_found', 'label': '未检测到人', 'action': 'idle'},
        ]
        sys.stdout.write(json.dumps({'gestures': gestures}) + '\n')
        sys.stdout.flush()


# ============================================================
# 入口
# ============================================================

def main():
    tracker = CameraTracker()

    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break

            line = line.strip()
            if not line:
                continue

            cmd = json.loads(line)
            cmd_type = cmd.get('cmd', '')

            if cmd_type == 'start':
                tracker.start()
            elif cmd_type == 'stop':
                tracker.stop()
            elif cmd_type == 'gesture_list':
                tracker.list_gestures()
            elif cmd_type == 'exit':
                tracker.stop()
                break
            else:
                sys.stdout.write(json.dumps({'error': f'未知命令: {cmd_type}'}) + '\n')
                sys.stdout.flush()
        except json.JSONDecodeError:
            sys.stdout.write(json.dumps({'error': '无效 JSON'}) + '\n')
            sys.stdout.flush()
        except KeyboardInterrupt:
            tracker.stop()
            break
        except Exception:
            traceback.print_exc(file=sys.stderr)
            break


if __name__ == '__main__':
    main()