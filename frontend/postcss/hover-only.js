// Hover только там, где он есть: каждое правило с :hover уезжает под
// @media (hover: hover) and (pointer: fine).
//
// На таче iOS/Android включают :hover в момент тапа и держат его, пока не
// коснёшься чего-то другого: карточка оставалась подсвеченной (а где hover
// двигает элемент — сдвинутой) после возврата на экран, и PWA выдавала себя
// за сайт. Отклик касания у нас свой (services/pressFeedback.js и :active).
//
// Руками этим медиазапросом обёрнута только часть правил — плагин делает
// это для всех при сборке, и новые правила не нужно помнить оборачивать.
// Селекторы без :hover из того же правила остаются на месте. Правила,
// уже лежащие внутри медиазапроса про hover/pointer, не трогаются.
const QUERY = '(hover: hover) and (pointer: fine)'
const HOVER = /:hover\b/

function insideHoverQuery(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'atrule' && p.name === 'media' && /\b(hover|pointer)\b/.test(p.params)) return true
    if (p.type === 'atrule' && /keyframes$/.test(p.name)) return true
  }
  return false
}

export default function hoverOnly() {
  return {
    postcssPlugin: 'hover-only',
    OnceExit(root, { AtRule }) {
      root.walkRules((rule) => {
        if (!HOVER.test(rule.selector) || insideHoverQuery(rule)) return
        const hover = rule.selectors.filter((s) => HOVER.test(s))
        const rest = rule.selectors.filter((s) => !HOVER.test(s))
        const media = new AtRule({ name: 'media', params: QUERY })
        if (rest.length) {
          media.append(rule.clone({ selectors: hover }))
          rule.selectors = rest
          rule.after(media)
        } else {
          rule.replaceWith(media)
          media.append(rule)
        }
      })
    },
  }
}
hoverOnly.postcss = true
