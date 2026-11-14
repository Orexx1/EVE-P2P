// The 3D view of the fight. Everything is drawn relative to the player's own
// ship, which sits at the origin: that keeps coordinates small (no jitter at
// 100 km) and lets the camera simply orbit the origin.
//
// Hulls are original stand-in shapes sized by ship class. The view only needs
// position, velocity and hull length per ship, so real models can replace
// `makeHull` without touching the rest of the game.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Vec3 } from '../sim/vec'

export interface ShipView {
  pos: Vec3
  vel: Vec3
  /** 0..1, how hard the engines are burning. */
  thrust: number
}

const FORWARD = new THREE.Vector3(0, 0, 1)
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

export class SpaceView {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(55, 1, 1, 1e7)
  private controls: OrbitControls
  private hulls: [THREE.Group, THREE.Group]
  private dust: THREE.Points
  private dustBase: Float32Array
  private dustBox: number
  private scratch = new THREE.Vector3()
  private turn = new THREE.Quaternion()

  constructor(
    private canvas: HTMLCanvasElement,
    lengths: [number, number],
    private me: 0 | 1,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0x05080c)

    this.scene.add(makeStars())
    const sun = new THREE.DirectionalLight(0xfff1dd, 2.4)
    sun.position.set(0.7, 0.45, 0.5)
    this.scene.add(sun, new THREE.AmbientLight(0x6f86a8, 0.9))

    this.hulls = [makeHull(lengths[0], me === 0 ? 0x7fd0ff : 0xffa45c), makeHull(lengths[1], me === 1 ? 0x7fd0ff : 0xffa45c)]
    this.hulls[1].quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
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

    this.camera.position.set(own * 1.9, own * 1.2, -own * 2.6)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enablePan = false
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    this.controls.minDistance = own * 1.4
    this.controls.maxDistance = 300_000
    this.controls.zoomSpeed = 1.4
  }

  resize(width: number, height: number) {
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  render(ships: [ShipView, ShipView]) {
    const origin = ships[this.me].pos
    ships.forEach((ship, i) => {
      const hull = this.hulls[i]
      hull.position.set(ship.pos[0] - origin[0], ship.pos[1] - origin[1], ship.pos[2] - origin[2])
      const speed = Math.hypot(...ship.vel)
      if (speed > 1) {
        this.scratch.set(ship.vel[0] / speed, ship.vel[1] / speed, ship.vel[2] / speed)
        this.turn.setFromUnitVectors(FORWARD, this.scratch)
        hull.quaternion.slerp(this.turn, 0.08)
      }
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

    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  /** Where a ship sits on screen, in CSS pixels, or null if it is behind the camera. */
  project(index: 0 | 1): { x: number; y: number } | null {
    this.scratch.copy(this.hulls[index].position).project(this.camera)
    if (this.scratch.z > 1) return null
    return {
      x: ((this.scratch.x + 1) / 2) * this.canvas.clientWidth,
      y: ((1 - this.scratch.y) / 2) * this.canvas.clientHeight,
    }
  }

  /** The direction in space under a point on screen: where a double-tap sends the ship. */
  directionAt(clientX: number, clientY: number): Vec3 {
    const rect = this.canvas.getBoundingClientRect()
    this.scratch
      .set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1, 0.5)
      .unproject(this.camera)
      .sub(this.camera.position)
      .normalize()
    return [this.scratch.x, this.scratch.y, this.scratch.z]
  }

  dispose() {
    this.controls.dispose()
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
