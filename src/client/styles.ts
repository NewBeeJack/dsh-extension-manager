/**
 * Scoped stylesheet for the Extension Manager settings section.
 *
 * Every color resolves through `--dsw-*` tokens so light/dark themes follow the
 * shell; motion is opt-in behind `prefers-reduced-motion: no-preference`; the
 * content column is designed for the ~564px Settings options area.
 */

const STYLE_TAG_ID = 'dsh-extension-manager/styles'

export const CSS = `
.em-root {
  container-type: inline-size;
  container-name: em;
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}

/* ---------------------------------------------------------------- *
 * Header
 * ---------------------------------------------------------------- */
.em-head { display: flex; flex-direction: column; gap: 10px; }
.em-headText { display: flex; flex-direction: column; gap: 3px; }
.em-titleRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.em-title {
  margin: 0;
  font-size: 20px;
  line-height: 28px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.em-previewTag { flex: none; }
.em-intro { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.em-tabsRow { display: flex; align-items: center; gap: 12px; min-width: 0; }
.em-scopeTabs { flex: none; width: 232px; }
.em-scanMeta {
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary);
}

/* ---------------------------------------------------------------- *
 * Notices
 * ---------------------------------------------------------------- */
.em-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-md);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.em-notice[data-tone='warning'] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 9%, transparent); }
.em-notice[data-tone='warning'] .em-noticeIcon,
.em-notice[data-tone='warning'] .em-noticeTitle { color: var(--dsw-alias-state-warn-label); }
.em-notice[data-tone='danger'] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.em-notice[data-tone='danger'] .em-noticeIcon,
.em-notice[data-tone='danger'] .em-noticeTitle { color: var(--dsw-alias-state-error-primary); }
.em-notice[data-tone='info'] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent); }
.em-notice[data-tone='info'] .em-noticeIcon,
.em-notice[data-tone='info'] .em-noticeTitle { color: var(--dsw-alias-state-business-primary); }
.em-notice[data-tone='success'] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent); }
.em-notice[data-tone='success'] .em-noticeIcon,
.em-notice[data-tone='success'] .em-noticeTitle { color: var(--dsw-alias-state-success-primary); }
.em-noticeIcon { flex: none; display: inline-flex; margin-top: 1px; }
.em-noticeBody { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.em-noticeTitle { font-weight: 500; }
.em-noticeText { min-width: 0; overflow-wrap: anywhere; }
.em-noticeActions { flex: none; align-self: center; display: inline-flex; gap: 6px; margin-left: 4px; }
.em-noticeList { margin: 2px 0 0; padding-left: 16px; display: flex; flex-direction: column; gap: 1px; }

/* ---------------------------------------------------------------- *
 * Statistics strip
 * ---------------------------------------------------------------- */
.em-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.em-stat {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  margin: 0;
  padding: 8px 10px 9px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-settings-card-fill);
  color: inherit;
  font: inherit;
  text-align: left;
}
.em-statButton { cursor: pointer; }
.em-statButton:hover { background: var(--dsw-alias-interactive-bg-hover); }
.em-statButton.is-active {
  border-color: var(--dsw-alias-state-business-primary);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-state-business-primary);
}
.em-statButton:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.em-statValue {
  font-size: 20px;
  line-height: 26px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
}
.em-statValue[data-tone='info'] { color: var(--dsw-alias-state-business-primary); }
.em-statValue[data-tone='danger'] { color: var(--dsw-alias-state-error-primary); }
.em-statLabel { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.em-statFilterGlyph {
  position: absolute;
  top: 7px;
  right: 8px;
  font-size: 9px;
  line-height: 14px;
  color: var(--dsw-alias-label-dimmed);
  opacity: 0;
}
.em-statButton:hover .em-statFilterGlyph,
.em-statButton.is-active .em-statFilterGlyph,
.em-statButton:focus-visible .em-statFilterGlyph { opacity: 1; }
.em-statSkeleton {
  display: inline-block;
  width: 30px;
  height: 18px;
  margin: 4px 0;
  border-radius: var(--dsw-radius-xs);
  background: var(--dsw-alias-bg-skeleton);
}

/* ---------------------------------------------------------------- *
 * Toolbar
 * ---------------------------------------------------------------- */
.em-toolbar { display: flex; flex-direction: column; gap: 8px; }
.em-toolRow { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; min-width: 0; }
.em-search { flex: 1 1 150px; min-width: 120px; }
.em-toolSpacer { flex: 1 1 auto; min-width: 0; }
.em-toolHint { margin: 0; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.em-filterPanel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-settings-card-fill);
}
.em-filterPanelRow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.em-filterPanelFoot {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding-top: 2px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.em-filterMatch { font-variant-numeric: tabular-nums; }
.em-statsDetails { margin: -2px 0 0; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.em-statsDetails summary { cursor: pointer; width: fit-content; }
.em-statsDetails summary:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
  border-radius: var(--dsw-radius-xs);
}
.em-statsDetails p { margin: 2px 0 0; }
.em-menuAnchor { display: inline-flex; min-width: 0; }
.em-menuAnchor .em-filterBtn {
  height: 28px;
  padding: 0 8px;
  gap: 4px;
  max-width: 180px;
  font-size: 12px;
  line-height: 18px;
}
.em-filterText { display: inline-flex; align-items: baseline; gap: 4px; min-width: 0; overflow: hidden; }
.em-filterLabel { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.em-filterValue { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.em-chevron { flex: none; color: var(--dsw-alias-label-tertiary); }
.em-toolRow .em-filterBtn:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}

/* ---------------------------------------------------------------- *
 * Icon buttons
 * ---------------------------------------------------------------- */
.em-iconBtn {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.em-iconBtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.em-iconBtn:disabled { opacity: 0.4; cursor: not-allowed; }
.em-iconBtn:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.em-copyBtn { width: 20px; height: 20px; color: var(--dsw-alias-label-tertiary); }
.em-copyBtn.is-copied { color: var(--dsw-alias-state-success-primary); }
.em-closeGlyph { font-size: 13px; line-height: 1; }
.em-spin { animation: em-spin 1s linear infinite; }

/* ---------------------------------------------------------------- *
 * Task panel
 * ---------------------------------------------------------------- */
.em-task {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
}
.em-task[data-tone='danger'] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }
.em-task[data-tone='success'] { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent); }
.em-taskHead { display: flex; align-items: center; gap: 8px; min-width: 0; }
.em-taskHeadline { font-size: 13px; line-height: 20px; font-weight: 500; min-width: 0; }
.em-taskTag { flex: none; }
.em-taskSpacer { flex: 1; }
.em-taskMessage { display: flex; align-items: center; gap: 4px; margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.em-taskFailure { display: flex; flex-direction: column; gap: 6px; }
.em-taskItemsBlock { display: flex; flex-direction: column; gap: 4px; }
.em-taskItemsToggle {
  align-self: flex-start;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--dsw-alias-state-business-primary);
  font: inherit;
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
}
.em-taskItemsToggle:focus-visible,
.em-taskItemsToggle:hover { text-decoration: underline; }
.em-taskItems {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 180px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}
.em-taskItem { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.em-taskItem[data-status='failed'] .em-taskItemName { color: var(--dsw-alias-state-error-primary); }
.em-taskItemName { font-weight: 500; }
.em-taskItemMessage { min-width: 0; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.em-taskItemVersion { color: var(--dsw-alias-label-tertiary); }
.em-taskActions { display: flex; gap: 6px; flex-wrap: wrap; }
.em-runningLine { display: inline-flex; align-items: center; gap: 6px; }
.em-inlineIcon { flex: none; color: var(--dsw-alias-state-success-primary); }
.em-progress {
  width: 100%;
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover);
}
.em-progressFill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--dsw-alias-state-business-primary);
  transition: width 220ms var(--ds-ease-in-out);
}

/* ---------------------------------------------------------------- *
 * Grouped list
 * ---------------------------------------------------------------- */
.em-groups { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.em-group { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.em-groupHead { display: flex; align-items: center; gap: 8px; min-height: 24px; }
.em-groupToggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  padding: 2px 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  cursor: pointer;
}
.em-groupToggle:hover { color: var(--dsw-alias-label-primary); }
.em-groupToggle:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
  border-radius: var(--dsw-radius-xs);
}
.em-groupToggle[aria-expanded='false'] .em-chevron { transform: rotate(-90deg); }
.em-groupTitle { min-width: 0; }
.em-groupCount {
  flex: none;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-tertiary);
  font-size: 10px;
  line-height: 16px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.em-groupMeta { margin-left: auto; font-size: 11px; line-height: 16px; color: var(--dsw-alias-state-business-primary); }
.em-listFooter { margin: 0; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.em-virtualList {
  max-height: min(65vh, 640px);
  overflow-y: auto;
  overscroll-behavior: contain;
  border-radius: var(--dsw-radius-lg);
  scrollbar-gutter: stable;
}
.em-virtualInner { position: relative; min-width: 0; }
.em-vitem { position: absolute; left: 0; right: 0; }
.em-vitemGroup { height: 32px; }
.em-vitemRow { height: 84px; padding-bottom: 6px; box-sizing: border-box; }
.em-vitemRow .em-row { height: 78px; overflow: hidden; }
.em-rows { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }

/* ---------------------------------------------------------------- *
 * Rows
 * ---------------------------------------------------------------- */
.em-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-settings-card-fill);
}
.em-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.em-rowIcon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 20px;
  margin-top: 1px;
  color: var(--dsw-alias-label-tertiary);
}
.em-rowBody { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.em-rowTop { display: flex; align-items: center; gap: 6px; min-width: 0; min-height: 22px; flex-wrap: nowrap; }
.em-rowName {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  margin: 0;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.em-rowName:hover { color: var(--dsw-alias-state-business-primary); }
.em-rowName:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
  border-radius: var(--dsw-radius-xs);
}
.em-rowVersion { flex: none; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.em-statusTag, .em-quietTag { flex: none; }
.em-rowActions { display: inline-flex; flex: none; align-items: center; gap: 2px; margin-left: auto; }
.em-rowActions .em-updateBtn { height: 24px; padding: 0 8px; font-size: 11px; line-height: 16px; gap: 3px; }
.em-rowActions .em-updateBtn[data-available='true'] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, transparent);
  color: var(--dsw-alias-state-business-primary);
}
.em-rowActions .em-updateBtn[data-available='true']:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent);
}
.em-rowDesc {
  margin: 0;
  overflow: hidden;
  font-size: 12px;
  line-height: 17px;
  color: var(--dsw-alias-label-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.em-rowMeta {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  font-size: 11px;
  line-height: 15px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.em-metaSource {
  flex: none;
  max-width: 132px;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.em-metaSep { flex: none; color: var(--dsw-alias-label-dimmed); }
.em-metaPath { display: inline-flex; align-items: center; gap: 2px; min-width: 0; flex: 0 1 auto; }
.em-metaPathText { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; }
.em-metaMuted { color: var(--dsw-alias-label-tertiary); }
.em-metaTail { display: inline-flex; flex: none; align-items: center; gap: 4px; margin-left: auto; white-space: nowrap; }
.em-metaNote { color: var(--dsw-alias-label-secondary); }
.em-metaChecked { color: var(--dsw-alias-label-tertiary); }

/* ---------------------------------------------------------------- *
 * Panel states: skeleton, empty, error
 * ---------------------------------------------------------------- */
.em-panel { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.em-panelFooter {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.em-linkButton {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--dsw-alias-state-business-primary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.em-linkButton:hover { text-decoration: underline; }
.em-linkButton:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.em-loading { display: flex; flex-direction: column; gap: 8px; }
.em-loadingLine { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.em-skeletonList { display: flex; flex-direction: column; gap: 6px; }
.em-skeletonRow {
  display: flex;
  gap: 10px;
  padding: 12px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-settings-card-fill);
}
.em-skeletonIcon { flex: none; width: 18px; height: 18px; border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-bg-skeleton); }
.em-skeletonBody { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.em-skeletonBar { width: 32%; height: 12px; border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-bg-skeleton); }
.em-skeletonBarWide { width: 78%; height: 10px; }
.em-skeletonBarShort { width: 52%; height: 10px; }
.em-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 28px 16px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-settings-card-fill);
  text-align: center;
}
.em-emptyIcon { margin-bottom: 2px; color: var(--dsw-alias-label-dimmed); display: inline-flex; }
.em-emptyTitle { margin: 0; font-size: 13px; line-height: 20px; font-weight: 500; }
.em-emptyText { max-width: 380px; margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.em-emptyAction { margin-top: 6px; }
.em-errorBlock { display: flex; flex-direction: column; gap: 8px; }
.em-errorActions { display: flex; gap: 6px; flex-wrap: wrap; }
.em-errorState {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 24px 16px;
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent);
  border-radius: var(--dsw-radius-lg);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 5%, transparent);
  text-align: center;
}
.em-errorIcon { color: var(--dsw-alias-state-error-primary); display: inline-flex; }
.em-errorTitle { margin: 0; font-size: 13px; font-weight: 500; }
.em-errorText { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.em-errorDetail { margin: 0; font-size: 10px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }

/* ---------------------------------------------------------------- *
 * Dialogs
 * ---------------------------------------------------------------- */
.em-modalWide {
  width: min(620px, 100%);
  /*
   * The primitive Modal root already reserves a 24px safety frame around the
   * card, so the card caps against that padded box instead of doing its own
   * viewport math. Height stays content-driven: short dialogs shrink, long
   * dialogs stop at the frame and scroll their body.
   */
  max-height: 100%;
  padding: 0;
  gap: 0;
  overflow: hidden;
}
/*
 * Shared layout contract for dialogs that use the primitive Modal chrome
 * (header + description + body + footer). The wide shell resets the primitive
 * dialog padding/gap, so this contract restores that rhythm exactly once:
 *  - dialog gap 20px separates the scrollable content region from the footer
 *    (the primitive default; no extra footer margin/padding-top);
 *  - the footer is a non-shrinking normal-flow row and owns the 24px bottom
 *    breathing room measured from the actual button edge;
 *  - top spacing is the primitive header rhythm (22px pad + 2px line centering
 *    = the measured 24px to the title glyphs), so no override is needed;
 *  - the content region is the only scroller (min-height: 0 keeps the flex
 *    child from pushing the footer out of the card).
 */
.em-dialogShell {
  gap: 20px;
}
.em-dialogShell > .em-modalScroll {
  flex: 1 1 auto;
  min-height: 0;
  overscroll-behavior: contain;
}
.em-dialogShell > .em-modalScroll > div:last-child {
  /* breathing room below the last body line when the content is scrolled out */
  padding-bottom: 8px;
}
.em-dialogShell > div:last-child:not(.em-modalScroll) {
  flex: none;
  padding: 0 24px 24px;
}
.em-modalScroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
/*
 * Headless detail shell: same layout contract as .em-dialogShell, implemented
 * by this dialog's own header/body/footer because it renders a richer header
 * inside a headless Modal. Metrics stay aligned with the shared contract:
 * content-driven height capped by the Modal root frame, one scrollable body,
 * 24px above the title glyphs and 24px below the action-row buttons.
 */
.em-detailDialog { display: flex; flex-direction: column; min-height: 0; max-height: 100%; }
.em-detailHead {
  display: flex;
  flex: none;
  align-items: flex-start;
  gap: 10px;
  padding: 24px 14px 12px 20px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.em-detailIcon { display: inline-flex; flex: none; margin-top: 2px; color: var(--dsw-alias-label-tertiary); }
.em-detailHeadText { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.em-detailTitleRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.em-detailTitle { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; min-width: 0; overflow-wrap: anywhere; }
.em-detailSubtitle { margin: 0; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.em-detailBody {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  padding: 14px 20px 18px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.em-detailFooter {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 10px 20px 24px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.em-detailFooterSpacer { flex: 1 1 auto; }
.em-detailSection { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.em-detailSection + .em-detailSection { border-top: 0.5px solid var(--dsw-alias-border-l1); padding-top: 12px; }
.em-detailSectionHead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.em-detailSectionTitle { margin: 0; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.em-facts { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 5px 12px; margin: 0; }
.em-fact { display: contents; }
.em-facts dt { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 17px; }
.em-facts dd { min-width: 0; margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 17px; overflow-wrap: anywhere; }
.em-factHint { display: block; margin-top: 1px; font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-tertiary); }
.em-pathRow { display: flex; align-items: flex-start; gap: 4px; min-width: 0; }
.em-pathValue { flex: 1; min-width: 0; font-size: 11px; line-height: 16px; overflow-wrap: anywhere; }
.em-detailMuted { margin: 0; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.em-detailInlineError { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.em-detailVersionAvailable { margin-left: 4px; color: var(--dsw-alias-label-tertiary); }
.em-errorText { color: var(--dsw-alias-state-error-primary); }
.em-link { color: var(--dsw-alias-link); text-decoration: none; overflow-wrap: anywhere; }
.em-link:hover { text-decoration: underline; }
.em-requirementList { margin: 0; padding-left: 16px; }
.em-fileList { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 2px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.em-breakAnywhere { overflow-wrap: anywhere; }

/* History */
.em-historyList { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.em-historyItem {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
}
.em-historyTop { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; line-height: 16px; }
.em-historyTime { color: var(--dsw-alias-label-tertiary); }
.em-historyAction { color: var(--dsw-alias-label-secondary); }
.em-historyMessage { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.em-historyMeta { margin: 0; font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }

/* Plugin rows / diagnostics lists */
.em-rowSummaryList { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.em-rowSummary {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 9px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
}
.em-rowSummaryTop { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.em-rowSummaryName { font-size: 12px; line-height: 18px; font-weight: 500; }
.em-rowSummaryMeta { margin: 0; font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.em-rowSummaryNote { margin: 0; font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
.em-rowSummaryError { margin: 0; font-size: 10px; line-height: 15px; color: var(--dsw-alias-state-error-primary); }
.em-diagnosticList { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.em-diagnosticItem { padding: 2px 0 2px 8px; border-left: 2px solid var(--dsw-alias-border-l3); }
.em-diagnosticItem[data-level='error'] { border-left-color: var(--dsw-alias-state-error-primary); }
.em-diagnosticItem[data-level='warning'] { border-left-color: var(--dsw-alias-state-warn-primary); }
.em-diagnosticTop { display: flex; align-items: center; gap: 6px; }
.em-diagnosticCode { font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
.em-diagnosticMessage { margin: 2px 0 0; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-secondary); }
.em-diagnosticDetail {
  max-height: 160px;
  margin: 4px 0 0;
  padding: 6px 8px;
  overflow: auto;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  font-size: 10px;
  line-height: 15px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Diagnostics dialog */
.em-reconHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.em-sourceFailures { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.em-sourceFailures li {
  padding: 7px 9px;
  border-radius: var(--dsw-radius-md);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 6%, transparent);
  font-size: 12px;
  line-height: 18px;
}
.em-sourceFailures p { margin: 2px 0 0; color: var(--dsw-alias-label-secondary); }
.em-sourceId { margin-left: 6px; font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.em-sourceLocation { font-size: 10px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.em-tableWrap { overflow-x: auto; }
.em-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 10.5px; line-height: 15px; }
.em-table th {
  padding: 4px 6px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-tertiary);
  font-weight: 500;
  text-align: left;
}
.em-table td {
  padding: 4px 6px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  vertical-align: top;
  overflow-wrap: anywhere;
}
.em-tableCellWrap { overflow-wrap: anywhere; }
.em-reconExtra { display: flex; flex-direction: column; gap: 4px; }
.em-probeList { display: flex; flex-direction: column; gap: 5px; margin: 0; padding: 0; list-style: none; }
.em-probe { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; line-height: 18px; }
.em-probeName { color: var(--dsw-alias-label-secondary); }

/* Update plan dialog */
.em-planSectionTitle { margin: 4px 0 0; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.em-planList { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.em-planItem {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
}
.em-planItem.is-muted { background: var(--dsw-alias-bg-module-platform); }
.em-planTop { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.em-planName { font-size: 13px; line-height: 20px; font-weight: 500; }
.em-planVersion { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.em-planRisk { margin: 0; font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-secondary); }
.em-planSource { margin: 0; font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
.em-ack {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.em-ack.is-checked { border-color: var(--dsw-alias-state-business-primary); }
.em-ack input { margin: 2px 0 0; accent-color: var(--dsw-alias-state-business-primary); }

/* ---------------------------------------------------------------- *
 * Shared utilities
 * ---------------------------------------------------------------- */
.em-srOnly {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}
.em-mono { font-family: var(--ds-font-family-code); }
.em-inlineTag { flex: none; }
.em-namedDot { display: inline-flex; }
.em-detailMuted.em-mono { overflow-wrap: anywhere; }

@media (prefers-reduced-motion: no-preference) {
  .em-chevron { transition: transform 140ms var(--ds-ease-in-out); }
  .em-statFilterGlyph { transition: opacity 120ms var(--ds-ease-in-out); }
  .em-skeletonBar, .em-skeletonIcon, .em-statSkeleton { animation: em-skeleton 1.8s cubic-bezier(0.36, 0, 0.64, 1) infinite; }
}

@keyframes em-skeleton {
  0% { opacity: 1; }
  45% { opacity: 0.55; }
  80%, 100% { opacity: 1; }
}

@keyframes em-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .em-spin { animation: none; }
  .em-progressFill { transition: none; }
}

@container em (max-width: 520px) {
  .em-scanMeta { display: none; }
  .em-facts { grid-template-columns: 76px minmax(0, 1fr); }
}
`

/** Inject the section stylesheet once per document; returns its disposer. */
export function installStyles(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${STYLE_TAG_ID}"]`)
  if (existing !== null) return () => undefined
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-extension-manager'
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
