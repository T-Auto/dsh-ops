// @ts-nocheck — ported from the shipped 4.1.8 reader as-is: the runtime is unchanged, the types
// are the open work. Tracked in docs/CHANGELOG.md under Unreleased.
'use strict';

const { TRUNCATED_MARK } = require('./core.cjs');

function countNewlines(text) {
  let n = 0;
  let i = -1;
  while ((i = text.indexOf('\n', i + 1)) !== -1) n++;
  return n;
}

/** 按字符切，且不劈开代理对（半截 emoji 会变成两个替换符） */
function cutChars(text, max) {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** 智能截断：截断时补标记，标记本身不计入 maxChars（由调用方决定预算口径） */
function truncate(text, maxChars) {
  if (text.length <= maxChars) return { content: text, truncated: false };
  return { content: cutChars(text, maxChars) + TRUNCATED_MARK, truncated: true };
}

/**
 * open 带 FD 耗尽退避。
 *
 * 并发的意义是把 10 个 open 压进一个窗口，副作用是宿主进程本来就紧张时更容易撞 EMFILE。
 * 撞上就立刻失败等于"防 FD 耗尽"这件事防了个寂寞，所以重试两次、退避 8/16ms。
 */

module.exports = { countNewlines, cutChars, truncate };
