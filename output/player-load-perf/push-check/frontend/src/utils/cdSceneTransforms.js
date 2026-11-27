// Camera movement does not change the deck's local/world transforms. Keep
// fixed parts out of Three's per-frame matrix work; mutable parts opt in.
export function freezeCdSceneTransforms(scene, dynamicObjects = []) {
  const dynamic = new Set(dynamicObjects)
  scene.traverse(object => {
    if (dynamic.has(object)) return
    object.updateMatrix()
    object.matrixAutoUpdate = false
  })
  scene.updateMatrixWorld(true)
}
