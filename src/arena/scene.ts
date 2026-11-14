// The stand-in 3D view of the fight: original hull shapes sized by ship class.
// It draws at once, on any device, and is what the fight falls back to when
// the real ship models cannot be loaded (see modelView.ts).
import * as THREE from 'three'
import { getGraphics, onGraphicsChange, pixelRatio } from '../ui/graphics'
import type { CameraRig, FightView, ShipView } from './rig'

const DUST_COUNT = 500

function makeHull(length: number, engine: number): THREE.Group {
  const hull = new THREE.Group()
  const plating = new THREE.MeshStandardMaterial({ color: 0x8793a0, roughness: 0.55, metalness: 0.6, flatShading: true })
  const dark = new THREE.MeshStandardMaterial({ color: 0x3d4753, roughness: 0.7, metalness: 0.5, flatShading: true })

  // Fuselage: a six-sided spindle, nose toward +Z.
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.015 * length, 0.11 * length, 0.55 * length, 6), plating)
  nose.rotation.x = Math.PI / 2
  nose.position.z = 0.2 * length
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.11 * length, 0.07 * length, 0.42 * length, 6), dark)
  tail.rotation.x = Math.PI / 2
  tail.position.z = -0.285 * length
  hull.add(nose, tail)

  // Outriggers.
  for (const side of [-1, 1]) {
    const pod = new THREE.Mesh(new THREE.BoxGeometry(0.05 * length, 0.035 * length, 0.4 * length), plating)
    pod.position.set(side * 0.19 * length, 0, -0.16 * length)
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.2 * length, 0.015 * length, 0.12 * length), dark)
    strut.position.set(side * 0.1 * length, 0, -0.2 * length)
    hull.add(pod, strut)
  }

  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.035 * length, 12, 8),
    new THREE.MeshBasicMaterial({ color: engine, transparent: true, opacity: 0.9 }),
  )
  glow.name = 'engine'
  glow.position.z = -0.51 * length
  hull.add(glow)
  return hull
}

function makeStars(): THREE.Points {
  const positions = new Float32Array(2500 * 3)
  const colors = new Float32Array(2500 * 3)
  const v = new THREE.Vector3()
  for (let i = 0; i < 2500; i++) {
    v.randomDirection().multiplyScalar(4e6)
    v.toArray(positions, i * 3)
    const warmth = Math.random()
    const brightness = 0.35 + Math.random() ** 3 * 0.65
    colors.set([brightness * (0.8 + 0.2 * warmth), brightness * 0.88, brightness * (1 - 0.2 * warmth)], i * 3)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return new THREE.Points(geometry, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true }))
}

export class SpaceView implements FightView {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private hulls: [THREE.Group, THREE.Group]
  private dust: THREE.Points
  private dustBase: Float32Array
  private dustBox: number
  private stopWatching: () => void
  private lastDrawn = 0

  constructor(
    canvas: HTMLCanvasElement,
    lengths: [number, number],
    private rig: CameraRig,
  ) {
    const me = rig.me
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: getGraphics().antialias, logarithmicDepthBuffer: true })
    this.renderer.setPixelRatio(pixelRatio())
    this.stopWatching = onGraphicsChange(() => {
      this.renderer.setPixelRatio(pixelRatio())
      this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false)
    })
    this.renderer.setClearColor(0x05080c)

    this.scene.add(makeStars())
    const sun = new THREE.DirectionalLight(0xfff1dd, 2.4)
    sun.position.set(0.7, 0.45, 0.5)
    this.scene.add(sun, new THREE.AmbientLight(0x6f86a8, 0.9))

    this.hulls = [makeHull(lengths[0], me === 0 ? 0x7fd0ff : 0xffa45c), makeHull(lengths[1], me === 1 ? 0x7fd0ff : 0xffa45c)]
    this.scene.add(...this.hulls)

    // Drifting dust around the ship: the only thing that makes speed visible
    // when the nearest object is kilometres away.
    const own = lengths[me]
    this.dustBox = own * 60
    this.dustBase = new Float32Array(DUST_COUNT * 3)
    for (let i = 0; i < this.dustBase.length; i++) this.dustBase[i] = Math.random() * this.dustBox
    const dustGeometry = new THREE.BufferGeometry()
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DUST_COUNT * 3), 3))
    this.dust = new THREE.Points(
      dustGeometry,
      new THREE.PointsMaterial({ color: 0x9fb4c8, size: 1.2, sizeAttenuation: false, transparent: true, opacity: 0.55 }),
    )
    this.dust.frustumCulled = false
    this.scene.add(this.dust)
  }

  resize(width: number, height: number) {
    this.renderer.setSize(width, height, false)
  }

  render(ships: [ShipView, ShipView]) {
    const fps = getGraphics().fps
    const now = performance.now()
    if (fps && now - this.lastDrawn < 1000 / fps - 4) return
    this.lastDrawn = now
    const origin = this.rig.origin
    ships.forEach((ship, i) => {
      const hull = this.hulls[i]
      hull.visible = ship.alive
      hull.position.copy(this.rig.offsets[i])
      hull.quaternion.copy(this.rig.turns[i])
      const engine = hull.getObjectByName('engine') as THREE.Mesh
      engine.scale.setScalar(0.4 + ship.thrust * 0.9)
    })

    const box = this.dustBox
    const out = this.dust.geometry.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < DUST_COUNT; i++) {
      for (let axis = 0; axis < 3; axis++) {
        const wrapped = (((this.dustBase[i * 3 + axis] - origin[axis]) % box) + box) % box
        out.array[i * 3 + axis] = wrapped - box / 2
      }
    }
    out.needsUpdate = true

    this.renderer.render(this.scene, this.rig.camera)
  }

  dispose() {
    this.stopWatching()
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      mesh.geometry?.dispose()
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(material)) material.forEach((m) => m.dispose())
      else material?.dispose()
    })
    this.renderer.dispose()
  }
}
