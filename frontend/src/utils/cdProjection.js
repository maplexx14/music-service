// Map bitmap corners to a projected plane, including perspective. Rectangular
// surfaces use their own height; disc surfaces default to a square.
function quadMatrix(quad) {
  const [p00, p10, p11, p01] = quad
  const dx1 = p10.x - p11.x
  const dx2 = p01.x - p11.x
  const dx3 = p00.x - p10.x + p11.x - p01.x
  const dy1 = p10.y - p11.y
  const dy2 = p01.y - p11.y
  const dy3 = p00.y - p10.y + p11.y - p01.y
  const denominator = dx1 * dy2 - dx2 * dy1
  const perspectiveX = Math.abs(denominator) > 0.000001 ? (dx3 * dy2 - dx2 * dy3) / denominator : 0
  const perspectiveY = Math.abs(denominator) > 0.000001 ? (dx1 * dy3 - dx3 * dy1) / denominator : 0
  const a = p10.x - p00.x + perspectiveX * p10.x
  const b = p01.x - p00.x + perspectiveY * p01.x
  const d = p10.y - p00.y + perspectiveX * p10.y
  const e = p01.y - p00.y + perspectiveY * p01.y
  return [a, b, p00.x, d, e, p00.y, perspectiveX, perspectiveY, 1]
}

function cssMatrix(m) {
  return `matrix3d(${m[0]},${m[3]},0,${m[6]},${m[1]},${m[4]},0,${m[7]},0,0,1,0,${m[2]},${m[5]},0,${m[8]})`
}

export function squareToQuadTransform(quad, width, height = width) {
  if (!quad?.length) return 'none'
  const m = quadMatrix(quad)
  for (const index of [0, 3, 6]) m[index] /= width
  for (const index of [1, 4, 7]) m[index] /= height
  return cssMatrix(m)
}

// Invert the actual screen plane for raycasting after native body transforms.
// Its corner markers include rotation, skew, and any entrance/action motion.
export function cdPointInQuad(quad, x, y) {
  if (quad?.length !== 4 || !Number.isFinite(x) || !Number.isFinite(y) ||
    !quad.every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))) return null
  const [a, b, c, d, e, f, g, h] = quadMatrix(quad)
  const ax = a - x * g, bx = b - x * h
  const ay = d - y * g, by = e - y * h
  const determinant = ax * by - bx * ay
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) return null
  const px = ((x - c) * by - bx * (y - f)) / determinant
  const py = (ax * (y - f) - (x - c) * ay) / determinant
  return Number.isFinite(px) && Number.isFinite(py) ? { x: px, y: py } : null
}

// Correct the small gap between a stored camera pose and the exact spring
// pose. One projective plane moves the whole bitmap without triangle seams.
export function cdQuadToQuadTransform(source, destination) {
  const m = quadMatrix(source), target = quadMatrix(destination)
  const [a, b, c, d, e, f, g, h, i] = m
  const inverse = [e * i - f * h, c * h - b * i, b * f - c * e,
    f * g - d * i, a * i - c * g, c * d - a * f,
    d * h - e * g, b * g - a * h, a * e - b * d]
  const determinant = a * inverse[0] + b * inverse[3] + c * inverse[6]
  if (Math.abs(determinant) < 1e-12) return 'none'
  const result = Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3), column = index % 3
    return (target[row * 3] * inverse[column] + target[row * 3 + 1] * inverse[column + 3] + target[row * 3 + 2] * inverse[column + 6]) / determinant
  })
  return cssMatrix(result)
}
