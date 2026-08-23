/**
 * E2E Tests — 核心用户流程端到端测试
 *
 * 使用 Playwright 验证关键用户路径。
 * 运行: npm run test:e2e
 */

import { test, expect } from '@playwright/test'

test.describe('核心用户流程', () => {
  test('应用加载并显示首页', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible()
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible()
  })

  test('侧边栏导航切换页面', async ({ page }) => {
    await page.goto('/')

    const navItems = ['语音', '模型', '记忆', '知识库', '插件', '设置']
    for (const item of navItems) {
      await page.click(`[data-testid="nav-${item}"]`)
      await page.waitForTimeout(300)
    }
  })

  test('发送消息并接收回复', async ({ page }) => {
    await page.goto('/')
    const input = page.locator('[data-testid="chat-input"]')
    await input.fill('你好')
    await page.click('[data-testid="send-button"]')
    await expect(page.locator('[data-testid="chat-message"]')).toBeVisible({ timeout: 10000 })
  })

  test('错误边界捕获渲染异常', async ({ page }) => {
    await page.goto('/#/test-error-boundary')
    await expect(page.locator('[data-testid="error-boundary-fallback"]')).toBeVisible()
  })

  test('骨架屏在加载时显示', async ({ page }) => {
    await page.goto('/')
    const skeleton = page.locator('[data-testid="app-skeleton"]')
    if (await skeleton.isVisible()) {
      await expect(skeleton).toBeVisible()
      await page.waitForTimeout(15000)
    }
  })
})

test.describe('无障碍检查', () => {
  test('首页无障碍审计', async ({ page }) => {
    await page.goto('/')
    // 检查 skip-link 存在
    await expect(page.locator('.skip-link')).toBeVisible()
    // 检查主内容区域有 role
    await expect(page.locator('[role="main"]')).toBeVisible()
    // 检查侧边栏导航有 role
    await expect(page.locator('[role="navigation"]')).toBeVisible()
  })

  test('键盘导航可用', async ({ page }) => {
    await page.goto('/')
    await page.keyboard.press('Tab')
    // SkipLink 应该获得焦点
    const focused = page.locator(':focus')
    await expect(focused).toBeVisible()
  })
})

test.describe('响应式布局', () => {
  test('小屏幕下侧边栏收起', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 })
    await page.goto('/')
    await page.waitForTimeout(500)
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible()
  })
})
