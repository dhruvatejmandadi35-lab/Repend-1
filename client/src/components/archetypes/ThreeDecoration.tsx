import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { motion } from "framer-motion";

interface Props {
  kind: "coin_stack" | "growing_sphere" | "bar_tower" | "none";
  value: number;
  range: [number, number];
  label?: string;
}

function CoinStack({ amount }: { amount: number }) {
  // amount in 0..1
  const count = Math.max(3, Math.round(3 + amount * 22));
  const coins = useMemo(() => Array.from({ length: count }, (_, i) => i), [count]);
  return (
    <group position={[0, -0.9, 0]}>
      {coins.map((i) => (
        <mesh key={i} position={[0, i * 0.16, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[0.55, 0.55, 0.14, 32]} />
          <meshStandardMaterial color="#D4A574" metalness={0.6} roughness={0.35} />
        </mesh>
      ))}
    </group>
  );
}

function GrowingSphere({ amount }: { amount: number }) {
  const ref = useRef<THREE.Mesh>(null);
  const scale = 0.4 + amount * 1.3;
  useFrame((_, dt) => {
    if (ref.current) {
      ref.current.rotation.y += dt * 0.4;
    }
  });
  return (
    <mesh ref={ref} scale={scale}>
      <icosahedronGeometry args={[1, 2]} />
      <meshStandardMaterial color="#3B82F6" emissive="#3B82F6" emissiveIntensity={0.15} roughness={0.25} metalness={0.4} />
    </mesh>
  );
}

function BarTower({ amount }: { amount: number }) {
  const blocks = Math.max(1, Math.round(amount * 12));
  return (
    <group position={[0, -1, 0]}>
      {Array.from({ length: blocks }, (_, i) => (
        <mesh key={i} position={[0, 0.2 + i * 0.22, 0]}>
          <boxGeometry args={[0.8, 0.2, 0.8]} />
          <meshStandardMaterial color="#3B82F6" emissive="#3B82F6" emissiveIntensity={0.08} roughness={0.4} />
        </mesh>
      ))}
    </group>
  );
}

export default function ThreeDecoration({ kind, value, range, label }: Props) {
  if (kind === "none") {
    return (
      <div className="w-full h-full flex items-center justify-center text-muted/40 font-mono text-xs">
        live output
      </div>
    );
  }

  const [min, max] = range;
  const normalized = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;

  return (
    <div className="relative w-full h-full">
      <Canvas
        camera={{ position: [0, 1.5, 5], fov: 38 }}
        gl={{ antialias: true, alpha: true }}
        dpr={[1, 2]}
      >
        <color attach="background" args={["#0B1220"]} />
        <ambientLight intensity={0.5} />
        <directionalLight position={[3, 4, 5]} intensity={1.2} castShadow />
        <directionalLight position={[-3, 1, -2]} intensity={0.3} color="#3B82F6" />
        {kind === "coin_stack" && <CoinStack amount={normalized} />}
        {kind === "growing_sphere" && <GrowingSphere amount={normalized} />}
        {kind === "bar_tower" && <BarTower amount={normalized} />}
      </Canvas>
      {label && (
        <motion.div
          key={`${value}`}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="absolute bottom-3 left-0 right-0 text-center font-mono text-[10px] uppercase tracking-widest text-muted/80"
        >
          {label}
        </motion.div>
      )}
    </div>
  );
}
