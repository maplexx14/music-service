// Keep the completed belt position while React moves this keyed record to its
// new queue slot. Clear the compensation only after that slot has committed.
export function returnCdQueueRecord(record) {
  const { node, parent, nextSibling, style, targetSlot } = record
  if (targetSlot == null) {
    node.style.cssText = style
    parent.insertBefore(node, nextSibling?.parentElement === parent ? nextSibling : null)
    return
  }
  const visible = node.getBoundingClientRect()
  node.style.cssText = style
  const originalTransform = node.dataset.cdQueueOriginalTransform ?? node.style.transform ?? ''
  const originalTransition = node.dataset.cdQueueOriginalTransition ?? node.style.transition ?? ''
  node.style.transition = 'none'
  node.style.transform = originalTransform
  parent.insertBefore(node, nextSibling?.parentElement === parent ? nextSibling : null)
  const resting = node.getBoundingClientRect()
  const dx = visible.left + visible.width / 2 - resting.left - resting.width / 2
  const dy = visible.top + visible.height / 2 - resting.top - resting.height / 2
  const scale = resting.width > 0 ? visible.width / resting.width : 1
  node.dataset.cdQueueTargetSlot = String(targetSlot)
  node.dataset.cdQueueOriginalTransform = originalTransform
  node.dataset.cdQueueOriginalTransition = originalTransition
  node.style.transform = `translate(${dx}px, ${dy}px) scale(${scale}) ${originalTransform}`.trim()
}

export function settleCdQueueRecord(node, slot) {
  if (node.dataset.cdQueueTargetSlot !== String(slot)) return
  node.style.transition = 'none'
  node.style.transform = node.dataset.cdQueueOriginalTransform || ''
  node.getBoundingClientRect()
  node.style.transition = node.dataset.cdQueueOriginalTransition || ''
  delete node.dataset.cdQueueTargetSlot
  delete node.dataset.cdQueueOriginalTransform
  delete node.dataset.cdQueueOriginalTransition
}
export function isCdQueueFrameReady(queue, position, record, direction) {
  return Boolean(queue && queue.dataset.cdQueuePosition === String(position) &&
    record?.dataset.queueSlot === String(direction) && record.querySelector('canvas') &&
    !queue.querySelector('[data-cd-queue-target-slot]'))
}

