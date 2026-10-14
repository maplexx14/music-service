// Длина самого длинного слова названия — для CSS (--title-chars, Artist.css):
// крупный заголовок шапки ужимается так, чтобы это слово влезло в ширину
// экрана целиком, а не рвалось посередине («Понравившиеся» на узких экранах).
export const titleFitStyle = (title) => ({
  '--title-chars': Math.max(1, ...String(title || '').split(/\s+/).map((word) => word.length)),
})
