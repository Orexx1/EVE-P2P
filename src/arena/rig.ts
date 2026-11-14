// The camera and the per-frame pose of every ship, shared by whichever view is
// drawing the fight (stand-in hulls or real models). Everything is expressed
// relative to the player's own ship, which sits at the origin: that keeps
// coordinates small (no jitter at 100 km) and lets the camera orbit the origin.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Vec3 } from '../sim/vec'

export interface ShipView {
  pos: Vec3
  vel: Vec3
  /** 0..1, how hard the engines are burning. */
  thrust: number
  /** False once the ship has been destroyed. */
  alive: boolean
}

/** What the arena needs from a view, whichever renderer is behind it. */
export interface FightView {
  render(ships: ShipView[]): void
  resize(width: number, height: number): void
  dispose(): void
}

const FORWARD = new THREE.Vector3(0, 0, 1)
export const FIELD_OF_VIEW = 55

export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 1, 1e7)
  /** Each ship's position relative to the player's ship. */
  readonly offsets: THREE.Vector3[]
  /** Each ship's orientation: nose along its velocity. */
  readonly turns: THREE.Quaternion[]
  origin: Vec3 = [0, 0, 0]
  private controls: OrbitControls
  private scratch = new THREE.Vector3()
  private turn = new THREE.Quaternion()

  /** `teams[i]` is the side ship i is on; the two teams start facing each other. */
  constructor(
    private surface: HTMLElement,
    ownLength: number,
    readonly me: number,
    teams: number[],
  ) {
    this.offsets = teams.map(() => new THREE.Vector3())
    this.turns = teams.map((team) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), team === 0 ? 0 : Math.PI))
    this.camera.position.set(ownLength * 1.9, ownLength * 1.2, -ownLength * 2.6)
    this.controls = new OrbitControls(this.camera, surface)
    this.controls.enablePan = false
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    this.controls.minDistance = ownLength * 1.4
    this.controls.maxDistance = 300_000
    this.controls.zoomSpeed = 1.4
  }

  /** How far the camera sits from the player's ship, in metres. */
  get distance(): number {
    return this.camera.position.length()
  }

  /** Called when the real hull turns out to be a different size from the estimate. */
  setOwnRadius(radius: number) {
    if (!(radius > 0)) return
    this.controls.minDistance = radius * 1.6
    if (this.distance < radius * 3.5) this.camera.position.setLength(radius * 3.5)
  }

  resize(width: number, height: number) {
    this.camera.aspect = width / Math.max(height, 1)
    this.camera.updateProjectionMatrix()
  }

  /** Brings poses and the camera up to date. Call once per frame, before drawing. */
  update(ships: ShipView[]) {
    const origin = (this.origin = ships[this.me].pos)
    ships.forEach((ship, i) => {
      this.offsets[i].set(ship.pos[0] - origin[0], ship.pos[1] - origin[1], ship.pos[2] - origin[2])
      const speed = Math.hypot(...ship.vel)
      if (speed > 1) {
        this.scratch.set(ship.vel[0] / speed, ship.vel[1] / speed, ship.vel[2] / speed)
        this.turn.setFromUnitVectors(FORWARD, this.scratch)
        this.turns[i].slerp(this.turn, 0.08)
      }
    })
    this.controls.update()
    this.camera.updateMatrixWorld()
  }

  /** Where a ship sits on screen, in CSS pixels, or null if it is behind the camera. */
  project(index: number): { x: number; y: number } | null {
    this.scratch.copy(this.offsets[index]).project(this.camera)
    if (this.scratch.z > 1) return null
    return {
      x: ((this.scratch.x + 1) / 2) * this.surface.clientWidth,
      y: ((1 - this.scratch.y) / 2) * this.surface.clientHeight,
    }
  }

  /** The direction in space under a point on screen: where a double-tap sends the ship. */
  directionAt(clientX: number, clientY: number): Vec3 {
    const rect = this.surface.getBoundingClientRect()
    this.scratch
      .set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1, 0.5)
      .unproject(this.camera)
      .sub(this.camera.position)
      .normalize()
    return [this.scratch.x, this.scratch.y, this.scratch.z]
  }

  dispose() {
    this.controls.dispose()
  }
}
