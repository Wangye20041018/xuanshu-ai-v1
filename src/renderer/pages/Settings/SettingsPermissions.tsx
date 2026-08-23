import { motion } from 'framer-motion'
import { Shield, CheckCircle, AlertCircle, RefreshCw } from 'lucide-react'
import { HEX_COLORS, COLORS, GlassCard, PermissionRow, glowPulse } from './index'
import type { Permission } from './index'

interface SettingsPermissionsProps {
  permissionStatus: { permissions: Permission[]; allGranted: boolean; requiredGranted: boolean }
  isLoading: boolean
  adminCheckStatus: 'idle' | 'checking' | 'checked' | 'error'
  registryCheckStatus: 'idle' | 'checking' | 'checked' | 'error'
  adminCheckError: string | null
  registryCheckError: string | null
  onCheckPermission: () => void
  onRequestPermission: (id: string) => void
  onRequestAll: () => void
  onRefreshAdmin: () => void
  onRestartAdmin: () => void
}

export default function SettingsPermissions({
  permissionStatus,
  isLoading,
  adminCheckStatus,
  registryCheckStatus,
  adminCheckError,
  registryCheckError,
  onCheckPermission,
  onRequestPermission,
  onRequestAll,
  onRefreshAdmin,
  onRestartAdmin,
}: SettingsPermissionsProps) {
  return (
    <GlassCard
      title="权限管理"
      icon={<Shield size={18} />}
      accentColor={COLORS.accent}
      headerRight={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* ---------- 管理员/注册表检测状态指示 ---------- */}
          {(adminCheckStatus === 'checking' || registryCheckStatus === 'checking') && (
            <span
              style={{
                fontSize: 11,
                color: COLORS.warning,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 8px',
                borderRadius: '8px',
background: COLORS.warningDim,
border: `1px solid ${HEX_COLORS.warning}26`,
              }}
            >
              <RefreshCw size={11} style={{ animation: 'spin 1s linear infinite' }} />
              检测中...
            </span>
          )}
          {(adminCheckStatus === 'error' || registryCheckStatus === 'error') && (
            <span
              style={{
                fontSize: 11,
                color: COLORS.danger,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 8px',
                borderRadius: '8px',
background: COLORS.dangerDim,
border: `1px solid ${HEX_COLORS.dangerAlt}26`,
              }}
            >
              <AlertCircle size={11} />
              检测异常
            </span>
          )}

          {/* ---------- 管理员/注册表专用刷新 ---------- */}
          <motion.button
            onClick={onRefreshAdmin}
            disabled={isLoading}
            whileHover={!isLoading ? { scale: 1.08, boxShadow: `0 0 12px ${HEX_COLORS.warning}20` } : {}}
            whileTap={!isLoading ? { scale: 0.9 } : {}}
            style={{
              width: 30,
              height: 30,
              borderRadius: '10px',
              border: `1px solid ${HEX_COLORS.warning}30`,
              background: 'transparent',
              color: COLORS.warning,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              opacity: isLoading ? 0.4 : 1,
            }}
            title="重新检测管理员/注册表权限"
          >
            <RefreshCw size={12} />
          </motion.button>

          {/* ---------- 以管理员身份重启 ---------- */}
          <motion.button
            onClick={onRestartAdmin}
            whileHover={{ scale: 1.06, boxShadow: `0 0 16px ${HEX_COLORS.purple}30` }}
            whileTap={{ scale: 0.93 }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '5px 12px',
borderRadius: '10px',
              border: `1px solid ${HEX_COLORS.purple}35`,
              background: `${HEX_COLORS.purple}12`,
              color: COLORS.purple,
              fontSize: 11,
              fontWeight: 500,
cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
            title="以管理员身份重启应用以获得完整系统权限"
          >
            <Shield size={12} />
            以管理员身份重启
          </motion.button>

          {/* ---------- 原有必需权限状态 ---------- */}
          {permissionStatus.requiredGranted ? (
            <motion.span
              animate={{ opacity: [0.7, 1, 0.7] }}
              transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
              style={{
                fontSize: 11,
                color: COLORS.success,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <CheckCircle size={12} />
              必需权限已获取
            </motion.span>
          ) : (
            <span
              style={{
                fontSize: 11,
                color: COLORS.danger,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <AlertCircle size={12} />
              部分权限缺失
            </span>
          )}

          {/* ---------- 全局刷新 ---------- */}
          <motion.button
            onClick={onCheckPermission}
            disabled={isLoading}
            whileHover={!isLoading ? { scale: 1.12, rotate: 180, boxShadow: `0 0 16px ${HEX_COLORS.accent}20` } : {}}
            whileTap={!isLoading ? { scale: 0.88 } : {}}
            transition={{ duration: 0.5 }}
            style={{
              width: 30,
              height: 30,
              borderRadius: '10px',
              border: `1px solid ${COLORS.cardBorder}`,
              background: 'transparent',
              color: COLORS.textSecondary,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              opacity: isLoading ? 0.4 : 1,
            }}
            title="刷新全部权限状态"
          >
            <RefreshCw size={12} style={isLoading ? { animation: 'spin 1s linear infinite' } : {}} />
          </motion.button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {permissionStatus.permissions.map((permission) => (
          <PermissionRow
            key={permission.id}
            permission={permission}
            onToggle={onRequestPermission}
            disabled={isLoading}
          />
        ))}
      </div>

      {/* ---------- 管理员/注册表检测状态详情 ---------- */}
      {(adminCheckStatus === 'checking' || registryCheckStatus === 'checking') && (
        <div
          style={{
            marginTop: 12,
            padding: '10px 14px',
            borderRadius: 'var(--radius-12)',
background: `${HEX_COLORS.warning}0f`,
border: `1px solid ${HEX_COLORS.warning}26`,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            color: COLORS.warning,
          }}
        >
          <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} />
          <span>
            {adminCheckStatus === 'checking' ? '管理员权限检测中...' : ''}
            {adminCheckStatus === 'checking' && registryCheckStatus === 'checking' ? ' / ' : ''}
            {registryCheckStatus === 'checking' ? '注册表权限检测中...' : ''}
          </span>
        </div>
      )}
      {(adminCheckStatus === 'error' || registryCheckStatus === 'error') && (
        <div
          style={{
            marginTop: 12,
            padding: '10px 14px',
            borderRadius: 'var(--radius-12)',
background: `${HEX_COLORS.dangerAlt}0f`,
border: `1px solid ${HEX_COLORS.dangerAlt}26`,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            fontSize: 12,
          }}
        >
          {adminCheckStatus === 'error' && adminCheckError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLORS.danger }}>
              <AlertCircle size={12} />
              <span><strong>管理员权限:</strong> {adminCheckError}</span>
            </div>
          )}
          {registryCheckStatus === 'error' && registryCheckError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLORS.danger }}>
              <AlertCircle size={12} />
              <span><strong>注册表权限:</strong> {registryCheckError}</span>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <span style={{ color: COLORS.textMuted, marginTop: 2 }}>
              请尝试以管理员身份重启应用，或点击手动检测重新尝试
            </span>
            <motion.button
              onClick={onRefreshAdmin}
              disabled={isLoading}
              whileHover={!isLoading ? { scale: 1.05 } : {}}
              whileTap={!isLoading ? { scale: 0.95 } : {}}
              style={{
                padding: '4px 12px',
borderRadius: 'var(--radius-8)',
                border: `1px solid ${HEX_COLORS.accent}40`,
                background: `${HEX_COLORS.accent}10`,
                color: COLORS.accent,
                fontSize: 11,
                fontWeight: 600,
cursor: isLoading ? 'not-allowed' : 'pointer',
                opacity: isLoading ? 0.5 : 1,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                whiteSpace: 'nowrap',
              }}
            >
              <RefreshCw size={12} />
              手动检测
            </motion.button>
          </div>
        </div>
      )}

      {!permissionStatus.requiredGranted && (
        <motion.button
          onClick={onRequestAll}
          disabled={isLoading}
          whileHover={!isLoading ? {
            scale: 1.03,
            boxShadow: `0 0 28px ${HEX_COLORS.accent}30, 0 0 12px ${HEX_COLORS.accent}15`,
          } : {}}
          whileTap={!isLoading ? { scale: 0.96 } : {}}
          animate={!isLoading ? glowPulse : {}}
          style={{
            width: '100%',
            marginTop: 20,
            padding: '14px 24px',
borderRadius: 'var(--radius-2xl)',
            border: `1px solid ${HEX_COLORS.accent}35`,
            background: `${HEX_COLORS.accent}12`,
            color: COLORS.accent,
            fontSize: 14,
            fontWeight: 600,
cursor: isLoading ? 'not-allowed' : 'pointer',
            opacity: isLoading ? 0.4 : 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
          }}
        >
          <Shield size={17} />
          一键获取所有权限
        </motion.button>
      )}
    </GlassCard>
  )
}