import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Play, RotateCcw } from "lucide-react";
import type { PhysicsObjectConfig, SimulationBlueprint } from "../../lib/types";

interface Props {
  blueprint: SimulationBlueprint;
  values: Record<string, number>;
}

function Floor() {
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.4, 0]} receiveShadow>
        <planeGeometry args={[20, 20]} />
        <meshStandardMaterial color="#0E1626" />
      </mesh>
      <gridHelper args={[20, 20, "#1f2a44", "#162033"]} position={[0, -1.39, 0]} />
    </>
  );
}

function PendulumScene({
  length,
  mass,
  initialAngleDeg,
  gravity,
  playing,
  resetKey,
}: {
  length: number;
  mass: number;
  initialAngleDeg: number;
  gravity: number;
  playing: boolean;
  resetKey: number;
}) {
  const angleRef = useRef((initialAngleDeg * Math.PI) / 180);
  const omegaRef = useRef(0);
  const meshRef = useRef<THREE.Group>(null);
  const pivot: [number, number, number] = [0, 1.4, 0];
  const radius = 0.18 + Math.min(0.25, mass * 0.06);

  useEffect(() => {
    angleRef.current = (initialAngleDeg * Math.PI) / 180;
    omegaRef.current = 0;
  }, [initialAngleDeg, length, resetKey]);

  useFrame((_, dt) => {
    if (!playing) return;
    const cappedDt = Math.min(dt, 0.05);
    const alpha = -(gravity / length) * Math.sin(angleRef.current);
    omegaRef.current += alpha * cappedDt;
    omegaRef.current *= 0.998;
    angleRef.current += omegaRef.current * cappedDt;

    if (meshRef.current) {
      meshRef.current.rotation.z = angleRef.current;
    }
  });

  return (
    <group position={pivot} ref={meshRef}>
      <mesh position={[0, 0, 0]}>
        <sphereGeometry args={[0.07, 24, 24]} />
        <meshStandardMaterial color="#D4A574" />
      </mesh>
      <mesh position={[0, -length / 2, 0]}>
        <cylinderGeometry args={[0.015, 0.015, length, 16]} />
        <meshStandardMaterial color="#94A3B8" />
      </mesh>
      <mesh position={[0, -length, 0]} castShadow>
        <sphereGeometry args={[radius, 32, 32]} />
        <meshStandardMaterial color="#3B82F6" metalness={0.5} roughness={0.3} emissive="#3B82F6" emissiveIntensity={0.18} />
      </mesh>
    </group>
  );
}

function ProjectileScene({
  velocity,
  angleDeg,
  height,
  gravity,
  playing,
  resetKey,
}: {
  velocity: number;
  angleDeg: number;
  height: number;
  gravity: number;
  playing: boolean;
  resetKey: number;
}) {
  const tRef = useRef(0);
  const meshRef = useRef<THREE.Mesh>(null);
  const [trail, setTrail] = useState<[number, number, number][]>([
    [-3, -1, 0],
    [-3, -1, 0.0001],
  ]);

  useEffect(() => {
    tRef.current = 0;
    setTrail([
      [-3, -1, 0],
      [-3, -1, 0.0001],
    ]);
  }, [velocity, angleDeg, height, gravity, resetKey]);

  useFrame((_, dt) => {
    if (!playing) return;
    tRef.current += Math.min(dt, 0.05);
    const t = tRef.current;
    const rad = (angleDeg * Math.PI) / 180;
    const vx = velocity * Math.cos(rad);
    const vy = velocity * Math.sin(rad);
    const x = vx * t;
    const y = height + vy * t - 0.5 * gravity * t * t;
    const sx = x * 0.15 - 3;
    const sy = Math.max(-1.35, y * 0.15 - 1);

    if (meshRef.current) {
      meshRef.current.position.set(sx, sy, 0);
    }
    setTrail((prev) => {
      const next: [number, number, number][] = [...prev, [sx, sy, 0]];
      if (next.length > 120) next.shift();
      return next;
    });

    if (y < -0.5 && tRef.current > 0.5) {
      tRef.current = 0;
      setTrail([
        [sx, sy, 0],
        [sx, sy, 0.0001],
      ]);
    }
  });

  return (
    <>
      <mesh ref={meshRef} position={[-3, -1, 0]} castShadow>
        <sphereGeometry args={[0.2, 24, 24]} />
        <meshStandardMaterial color="#3B82F6" emissive="#3B82F6" emissiveIntensity={0.3} />
      </mesh>
      {trail.length > 1 && <Line points={trail} color="#D4A574" lineWidth={2} />}
    </>
  );
}

function CartScene({
  force,
  mass,
  frictionCoeff,
  gravity,
  playing,
  resetKey,
}: {
  force: number;
  mass: number;
  frictionCoeff: number;
  gravity: number;
  playing: boolean;
  resetKey: number;
}) {
  const xRef = useRef(-2);
  const vRef = useRef(0);
  const meshRef = useRef<THREE.Group>(null);
  const wheelLeft = useRef<THREE.Mesh>(null);
  const wheelRight = useRef<THREE.Mesh>(null);

  useEffect(() => {
    xRef.current = -2;
    vRef.current = 0;
  }, [resetKey]);

  useFrame((_, dt) => {
    if (!playing) return;
    const cappedDt = Math.min(dt, 0.05);
    const friction = frictionCoeff * mass * gravity;
    const netForce = Math.max(0, force - friction) * Math.sign(force) || (force > friction ? force - friction : 0);
    const accel = netForce / Math.max(0.1, mass);
    vRef.current += accel * cappedDt;
    xRef.current += vRef.current * cappedDt * 0.3;
    if (xRef.current > 3) {
      xRef.current = -2;
      vRef.current = 0;
    }
    if (meshRef.current) meshRef.current.position.x = xRef.current;
    if (wheelLeft.current) wheelLeft.current.rotation.z -= vRef.current * cappedDt * 0.6;
    if (wheelRight.current) wheelRight.current.rotation.z -= vRef.current * cappedDt * 0.6;
  });

  return (
    <group ref={meshRef} position={[-2, -1, 0]}>
      <mesh castShadow>
        <boxGeometry args={[1.2, 0.55, 0.7]} />
        <meshStandardMaterial color="#3B82F6" metalness={0.5} roughness={0.4} emissive="#3B82F6" emissiveIntensity={0.1} />
      </mesh>
      <mesh ref={wheelLeft} position={[-0.4, -0.35, 0.4]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.2, 0.2, 0.1, 24]} />
        <meshStandardMaterial color="#1f2a44" />
      </mesh>
      <mesh ref={wheelRight} position={[0.4, -0.35, 0.4]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.2, 0.2, 0.1, 24]} />
        <meshStandardMaterial color="#1f2a44" />
      </mesh>
      <mesh position={[-0.4, -0.35, -0.4]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.2, 0.2, 0.1, 24]} />
        <meshStandardMaterial color="#1f2a44" />
      </mesh>
      <mesh position={[0.4, -0.35, -0.4]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.2, 0.2, 0.1, 24]} />
        <meshStandardMaterial color="#1f2a44" />
      </mesh>
      <mesh position={[1.1, 0, 0]}>
        <coneGeometry args={[0.12, 0.4, 24]} />
        <meshStandardMaterial color="#D4A574" emissive="#D4A574" emissiveIntensity={0.25} />
      </mesh>
    </group>
  );
}

function SpringScene({
  k,
  mass,
  displacement,
  playing,
  resetKey,
}: {
  k: number;
  mass: number;
  displacement: number;
  playing: boolean;
  resetKey: number;
}) {
  const xRef = useRef(displacement);
  const vRef = useRef(0);
  const meshRef = useRef<THREE.Mesh>(null);
  useEffect(() => {
    xRef.current = displacement;
    vRef.current = 0;
  }, [displacement, k, mass, resetKey]);

  useFrame((_, dt) => {
    if (!playing) return;
    const cappedDt = Math.min(dt, 0.05);
    const a = (-k * xRef.current) / Math.max(0.1, mass);
    vRef.current += a * cappedDt;
    vRef.current *= 0.995;
    xRef.current += vRef.current * cappedDt;
    if (meshRef.current) meshRef.current.position.y = xRef.current * 0.3 - 0.5;
  });

  return (
    <>
      <mesh position={[0, 1.4, 0]}>
        <boxGeometry args={[1.4, 0.1, 0.6]} />
        <meshStandardMaterial color="#94A3B8" />
      </mesh>
      <mesh ref={meshRef} position={[0, -0.5, 0]} castShadow>
        <sphereGeometry args={[0.35, 32, 32]} />
        <meshStandardMaterial color="#3B82F6" emissive="#3B82F6" emissiveIntensity={0.2} />
      </mesh>
    </>
  );
}

function OrbitScene({
  radius,
  speed,
  playing,
  resetKey,
}: {
  radius: number;
  speed: number;
  playing: boolean;
  resetKey: number;
}) {
  const thetaRef = useRef(0);
  const meshRef = useRef<THREE.Mesh>(null);
  useEffect(() => {
    thetaRef.current = 0;
  }, [resetKey]);
  useFrame((_, dt) => {
    if (!playing) return;
    thetaRef.current += dt * speed;
    if (meshRef.current) {
      meshRef.current.position.x = Math.cos(thetaRef.current) * radius;
      meshRef.current.position.z = Math.sin(thetaRef.current) * radius;
    }
  });
  return (
    <>
      <mesh>
        <sphereGeometry args={[0.5, 32, 32]} />
        <meshStandardMaterial color="#D4A574" emissive="#D4A574" emissiveIntensity={0.4} />
      </mesh>
      <mesh ref={meshRef} castShadow>
        <sphereGeometry args={[0.15, 24, 24]} />
        <meshStandardMaterial color="#3B82F6" emissive="#3B82F6" emissiveIntensity={0.3} />
      </mesh>
    </>
  );
}

function InclinedPlaneScene({
  angle,
  mass,
  frictionCoeff,
  gravity,
  playing,
  resetKey,
}: {
  angle: number;
  mass: number;
  frictionCoeff: number;
  gravity: number;
  playing: boolean;
  resetKey: number;
}) {
  const sRef = useRef(0);
  const vRef = useRef(0);
  const groupRef = useRef<THREE.Group>(null);
  const rad = (angle * Math.PI) / 180;

  useEffect(() => {
    sRef.current = 0;
    vRef.current = 0;
  }, [angle, mass, frictionCoeff, resetKey]);

  useFrame((_, dt) => {
    if (!playing) return;
    const cappedDt = Math.min(dt, 0.05);
    const a = gravity * (Math.sin(rad) - frictionCoeff * Math.cos(rad));
    vRef.current += a * cappedDt;
    sRef.current += vRef.current * cappedDt * 0.2;
    if (sRef.current > 3) {
      sRef.current = 0;
      vRef.current = 0;
    }
    if (groupRef.current) {
      groupRef.current.position.x = -2 + Math.cos(rad) * sRef.current;
      groupRef.current.position.y = 1 - Math.sin(rad) * sRef.current;
    }
  });

  return (
    <>
      <mesh position={[0, 0, 0]} rotation={[0, 0, -rad]}>
        <boxGeometry args={[5, 0.1, 1.2]} />
        <meshStandardMaterial color="#94A3B8" />
      </mesh>
      <group ref={groupRef} rotation={[0, 0, -rad]}>
        <mesh castShadow>
          <boxGeometry args={[0.4, 0.3, 0.5]} />
          <meshStandardMaterial color="#3B82F6" emissive="#3B82F6" emissiveIntensity={0.15} />
        </mesh>
      </group>
    </>
  );
}

function CollisionScene({
  v1,
  m1,
  m2,
  playing,
  resetKey,
}: {
  v1: number;
  m1: number;
  m2: number;
  playing: boolean;
  resetKey: number;
}) {
  const x1 = useRef(-2.5);
  const x2 = useRef(0.5);
  const vel1 = useRef(v1);
  const vel2 = useRef(0);
  const collided = useRef(false);

  const ball1 = useRef<THREE.Mesh>(null);
  const ball2 = useRef<THREE.Mesh>(null);

  useEffect(() => {
    x1.current = -2.5;
    x2.current = 0.5;
    vel1.current = v1;
    vel2.current = 0;
    collided.current = false;
  }, [v1, m1, m2, resetKey]);

  useFrame((_, dt) => {
    if (!playing) return;
    const cappedDt = Math.min(dt, 0.05);
    x1.current += vel1.current * cappedDt * 0.5;
    x2.current += vel2.current * cappedDt * 0.5;
    if (!collided.current && x1.current + 0.4 > x2.current - 0.4 && vel1.current > vel2.current) {
      const totalMass = m1 + m2;
      const newV1 = ((m1 - m2) * vel1.current + 2 * m2 * vel2.current) / totalMass;
      const newV2 = ((m2 - m1) * vel2.current + 2 * m1 * vel1.current) / totalMass;
      vel1.current = newV1;
      vel2.current = newV2;
      collided.current = true;
    }
    if (ball1.current) ball1.current.position.x = x1.current;
    if (ball2.current) ball2.current.position.x = x2.current;
    if (x1.current > 4 || x2.current > 4 || x1.current < -5) {
      x1.current = -2.5;
      x2.current = 0.5;
      vel1.current = v1;
      vel2.current = 0;
      collided.current = false;
    }
  });

  const r1 = 0.2 + Math.min(0.4, m1 * 0.06);
  const r2 = 0.2 + Math.min(0.4, m2 * 0.06);
  return (
    <>
      <mesh ref={ball1} position={[-2.5, -0.5, 0]} castShadow>
        <sphereGeometry args={[r1, 32, 32]} />
        <meshStandardMaterial color="#3B82F6" emissive="#3B82F6" emissiveIntensity={0.25} />
      </mesh>
      <mesh ref={ball2} position={[0.5, -0.5, 0]} castShadow>
        <sphereGeometry args={[r2, 32, 32]} />
        <meshStandardMaterial color="#D4A574" emissive="#D4A574" emissiveIntensity={0.25} />
      </mesh>
    </>
  );
}

function CameraFit() {
  const { camera } = useThree();
  useEffect(() => {
    camera.position.set(0, 1.5, 6);
    camera.lookAt(0, 0, 0);
  }, [camera]);
  return null;
}

function pickVar(values: Record<string, number>, candidates: string[], fallback: number): number {
  for (const c of candidates) {
    if (values[c] !== undefined && Number.isFinite(values[c])) return values[c];
  }
  return fallback;
}

export default function PhysicsObject({ blueprint, values }: Props) {
  const cfg = blueprint.config as PhysicsObjectConfig;
  const [playing, setPlaying] = useState(true);
  const [resetKey, setResetKey] = useState(0);
  const gravity = cfg.worldGravity;

  // Auto-restart key when values change so the scene reflects new params immediately
  const valuesKey = JSON.stringify(values);
  useEffect(() => {
    setResetKey((k) => k + 1);
  }, [valuesKey]);

  const renderScene = () => {
    switch (cfg.object) {
      case "pendulum": {
        const length = pickVar(values, ["length", "L", "rope_length", "string_length"], 1.8);
        const mass = pickVar(values, ["mass", "m", "bob_mass"], 1);
        const angle = pickVar(values, ["initial_angle", "angle", "theta", "amplitude"], 30);
        return (
          <PendulumScene
            length={Math.min(2.4, Math.max(0.4, length))}
            mass={mass}
            initialAngleDeg={angle}
            gravity={gravity}
            playing={playing}
            resetKey={resetKey}
          />
        );
      }
      case "projectile": {
        const velocity = pickVar(values, ["initial_velocity", "velocity", "v", "speed", "launch_speed"], 20);
        const angle = pickVar(values, ["launch_angle", "angle", "theta"], 45);
        const height = pickVar(values, ["height", "h", "initial_height"], 0);
        return (
          <ProjectileScene
            velocity={velocity}
            angleDeg={angle}
            height={height}
            gravity={gravity}
            playing={playing}
            resetKey={resetKey}
          />
        );
      }
      case "spring": {
        const k = pickVar(values, ["k", "stiffness", "spring_constant"], 10);
        const mass = pickVar(values, ["mass", "m"], 1);
        const displacement = pickVar(values, ["displacement", "amplitude", "x0"], 1);
        return <SpringScene k={k} mass={mass} displacement={displacement} playing={playing} resetKey={resetKey} />;
      }
      case "orbit": {
        const radius = pickVar(values, ["radius", "r", "orbit_radius", "distance"], 2);
        const speed = pickVar(values, ["speed", "angular_velocity", "omega", "velocity"], 1);
        return <OrbitScene radius={Math.min(2.8, radius)} speed={speed} playing={playing} resetKey={resetKey} />;
      }
      case "inclined_plane": {
        const angle = pickVar(values, ["angle", "theta", "incline_angle"], 20);
        const mass = pickVar(values, ["mass", "m"], 1);
        const friction = pickVar(values, ["friction_coeff", "friction", "mu"], 0.1);
        return (
          <InclinedPlaneScene
            angle={Math.min(60, Math.max(0, angle))}
            mass={mass}
            frictionCoeff={friction}
            gravity={gravity}
            playing={playing}
            resetKey={resetKey}
          />
        );
      }
      case "collision": {
        const v1 = pickVar(values, ["v1", "velocity_1", "initial_velocity", "velocity"], 3);
        const m1 = pickVar(values, ["m1", "mass_1", "mass"], 1);
        const m2 = pickVar(values, ["m2", "mass_2"], 1);
        return <CollisionScene v1={v1} m1={m1} m2={m2} playing={playing} resetKey={resetKey} />;
      }
      case "cart":
      default: {
        const force = pickVar(values, ["force", "F", "applied_force"], 10);
        const mass = pickVar(values, ["mass", "m"], 1);
        const friction = pickVar(values, ["friction_coeff", "friction", "mu"], 0.1);
        return (
          <CartScene
            force={force}
            mass={mass}
            frictionCoeff={friction}
            gravity={gravity}
            playing={playing}
            resetKey={resetKey}
          />
        );
      }
    }
  };

  return (
    <div className="relative w-full h-[400px] glass-strong overflow-hidden">
      <Canvas
        shadows
        camera={{ position: [0, 1.5, 6], fov: 42 }}
        gl={{ antialias: true, alpha: false }}
        dpr={[1, 2]}
      >
        <color attach="background" args={["#0B1220"]} />
        <CameraFit />
        <ambientLight intensity={0.45} />
        <directionalLight position={[4, 6, 4]} intensity={1.1} castShadow shadow-mapSize={[1024, 1024]} />
        <directionalLight position={[-4, 2, -3]} intensity={0.35} color="#3B82F6" />
        <Floor />
        {renderScene()}
      </Canvas>
      <div className="absolute top-3 right-3 flex gap-2">
        <button
          className="px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-mono text-text flex items-center gap-1.5"
          onClick={() => setPlaying((p) => !p)}
        >
          <Play size={12} className={playing ? "fill-current" : ""} />
          {playing ? "Pause" : "Play"}
        </button>
        <button
          className="px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-mono text-text flex items-center gap-1.5"
          onClick={() => setResetKey((k) => k + 1)}
        >
          <RotateCcw size={12} />
          Reset
        </button>
      </div>
      <div className="absolute bottom-3 left-3 right-3 text-xs font-mono text-muted/80 max-w-md">
        {cfg.description}
      </div>
    </div>
  );
}
