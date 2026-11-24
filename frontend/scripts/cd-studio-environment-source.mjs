import { Color, DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry, PMREMGenerator, Scene } from 'three'

// Original player studio, unchanged. Used only by the asset baking tool.
export function bakeStudioEnvironment(renderer) {
  const environment = new Scene()
  environment.background = new Color().setRGB(0.04, 0.045, 0.06)
  const geometry = new PlaneGeometry(1, 1)
  for (const [width, height, position, color, intensity] of [
    [4.5, 5.5, [-4, 4.5, 7], '#fffaf2', 3.4],
    [1.25, 6, [4, 1.5, 6], '#e9eef5', 2.1],
    [5, 2, [0, 7, 1], '#ffffff', 2.4],
    [2.5, 5, [4, 3, -5], '#e2e8ef', 2.5],
  ]) {
    const panel = new Mesh(geometry, new MeshBasicMaterial({
      color: new Color(color).multiplyScalar(intensity), side: DoubleSide, toneMapped: false,
    }))
    panel.position.set(...position)
    panel.scale.set(width, height, 1)
    panel.lookAt(0, 0, 0)
    environment.add(panel)
  }
  const generator = new PMREMGenerator(renderer)
  try { return generator.fromScene(environment, 0.06) }
  finally {
    geometry.dispose()
    environment.traverse(object => { if (object.isMesh) object.material.dispose() })
    generator.dispose()
  }
}
