/**
 * dsh-extension-manager — Web client half.
 *
 * Registers one Settings section and renders the unified Plugins / Skills
 * manager. All data comes from the Host JSON API (`src/client/api.ts`); this
 * bundle only renders and triggers controlled requests.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { installStyles } from './styles'
import { ExtensionManagerSection } from './app'

export const inject = ['slots']

/** Mount styles and the settings section registration. */
export function apply(ctx: Context): void {
  ctx.effect(() => installStyles(), 'extension-manager: styles')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'extension-manager',
    order: 26,
    label: () => '扩展管理器',
  }, ExtensionManagerSection))
}
