import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { ParticleFieldConfig, SimulationBlueprint } from "../../lib/types";
import { evalFormula } from "../../lib/formula";

interface Props {
  blueprint: SimulationBlueprint;
  values: Record<string, number>;
}

function Particles({ count, rule, speed }: { count: number; rule: string; speed: number }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const positions = useMemo(() => {
    return Array.from({ length: count }, () => ({
      x: (Math.random() - 0.5) * 6,
      y: (Math.random() - 0.5) * 3,
      z: (Math.random() - 0.5) * 3,
      vx: (Math.random() - 0.5) * 0.5,
      vy: (Math.random() - 0.5) * 0.5,
      vz: (Math.random() - 0.5) * 0.5,
    }));
  }, [count]);

  useEffect(() => {
    // reset velocities when rule changes
    positions.forEach((p) => {
      p.vx = (Math.random() - 0.5) * 0.5;
      p.vy = (Math.random() - 0.5) * 0.5;
      p.vz = (Math.random() - 0.5) * 0.5;
    });
  }, [rule, positions]);

  useFrame((_, dt) => {
    const cappedDt = Math.min(dt, 0.05);
    const s = Math.max(0.01, speed);
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      switch (rule) {
        case "brownian":
          p.vx += (Math.random() - 0.5) * 0.6 * s;
          p.vy += (Math.random() - 0.5) * 0.6 * s;
          p.vz += (Math.random() - 0.5) * 0.6 * s;
          p.vx *= 0.92;
          p.vy *= 0.92;
          p.vz *= 0.92;
          break;
        case "attract": {
          const dx = -p.x;
          const dy = -p.y;
          const dz = -p.z;
          const d = Math.hypot(dx, dy, dz) || 1;
          p.vx += (dx / d) * s * 0.8;
          p.vy += (dy / d) * s * 0.8;
          p.vz += (dz / d) * s * 0.8;
          p.vx *= 0.95;
          p.vy *= 0.95;
          p.vz *= 0.95;
          break;
        }
        case "repel": {
          const d = Math.hypot(p.x, p.y, p.z) || 1;
          p.vx += (p.x / d) * s * 0.3;
          p.vy += (p.y / d) * s * 0.3;
          p.vz += (p.z / d) * s * 0.3;
          p.vx *= 0.96;
          p.vy *= 0.96;
          p.vz *= 0.96;
          break;
        }
        case "flow":
          p.vx = s * 1.5;
          p.vy = Math.sin(p.x * 0.5 + Date.now() * 0.001) * 0.2;
          p.vz *= 0.9;
          break;
        case "diffusion":
          p.vx += (Math.random() - 0.5) * 0.3 * s;
          p.vy += (Math.random() - 0.5) * 0.3 * s;
          p.vz += (Math.random() - 0.5) * 0.3 * s;
          p.vx *= 0.97;
          p.vy *= 0.97;
          p.vz *= 0.97;
          break;
        case "boids":
        default:
          p.vx += (Math.random() - 0.5) * 0.1 * s;
          p.vy += (Math.random() - 0.5) * 0.1 * s;
      }
      p.x += p.vx * cappedDt;
      p.y += p.vy * cappedDt;
      p.z += p.vz * cappedDt;
      // bounce / wrap
      if (Math.abs(p.x) > 3) {
        p.vx *= -0.6;
        p.x = Math.sign(p.x) * 3;
      }
      if (Math.abs(p.y) > 1.5) {
        p.vy *= -0.6;
        p.y = Math.sign(p.y) * 1.5;
      }
      if (Math.abs(p.z) > 1.5) {
        p.vz *= -0.6;
        p.z = Math.sign(p.z) * 1.5;
      }
      dummy.position.set(p.x, p.y, p.z);
      dummy.updateMatrix();
      meshRef.current?.setMatrixAt(i, dummy.matrix);
    }
    if (meshRef.current) meshRef.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, count]}>
      <sphereGeometry args={[0.05, 8, 8]} />
      <meshStandardMaterial color="#3B82F6" emissive="#3B82F6" emissiveIntensity={0.5} />
    </instancedMesh>
  );
}

export default function ParticleField({ blueprint, values }: Props) {
  const cfg = blueprint.config as ParticleFieldConfig;
  const variableNames = blueprint.variables.map((v) => v.name);
  const speed = evalFormula(cfg.speedFormula, values, variableNames);
  const effectiveSpeed = Number.isFinite(speed) ? speed : 1;

  return (
    <div className="relative w-full h-[400px] glass-strong overflow-hidden">
      <Canvas camera={{ position: [0, 0, 6], fov: 50 }} gl={{ antialias: true }} dpr={[1, 2]}>
        <color attach="background" args={["#0B1220"]} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[3, 4, 5]} intensity={0.8} />
        <Particles count={Math.min(2000, cfg.particleCount)} rule={cfg.rule} speed={effectiveSpeed} />
      </Canvas>
      <div className="absolute bottom-3 left-3 right-3 text-xs font-mono text-muted/80 flex justify-between gap-3">
        <span className="truncate">{cfg.description}</span>
        <span className="shrink-0 text-accent/80">
          rule · <span className="text-text">{cfg.rule}</span>
        </span>
      </div>
    </div>
  );
}
