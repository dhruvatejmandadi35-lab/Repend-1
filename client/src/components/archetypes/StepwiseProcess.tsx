import { Canvas, useFrame } from "@react-three/fiber";
import { useRef, useState } from "react";
import * as THREE from "three";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { StepwiseProcessConfig, SimulationBlueprint } from "../../lib/types";

interface Props {
  blueprint: SimulationBlueprint;
  values: Record<string, number>;
}

function SplitStrand() {
  const ref = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 0.2;
  });
  return (
    <group ref={ref}>
      {Array.from({ length: 16 }, (_, i) => {
        const t = i / 16;
        const y = (i - 8) * 0.2;
        const phase = t * Math.PI * 4;
        return (
          <group key={i}>
            <mesh position={[Math.cos(phase) * 0.7, y, Math.sin(phase) * 0.7]}>
              <sphereGeometry args={[0.1, 16, 16]} />
              <meshStandardMaterial color="#3B82F6" emissive="#3B82F6" emissiveIntensity={0.2} />
            </mesh>
            <mesh position={[-Math.cos(phase) * 0.7, y, -Math.sin(phase) * 0.7]}>
              <sphereGeometry args={[0.1, 16, 16]} />
              <meshStandardMaterial color="#D4A574" emissive="#D4A574" emissiveIntensity={0.2} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

function PrimerAttach() {
  return (
    <group>
      {Array.from({ length: 10 }, (_, i) => (
        <mesh key={i} position={[(i - 4.5) * 0.3, 0, 0]}>
          <boxGeometry args={[0.25, 0.4, 0.25]} />
          <meshStandardMaterial
            color={i >= 3 && i <= 5 ? "#D4A574" : "#3B82F6"}
            emissive={i >= 3 && i <= 5 ? "#D4A574" : "#3B82F6"}
            emissiveIntensity={i >= 3 && i <= 5 ? 0.5 : 0.1}
          />
        </mesh>
      ))}
    </group>
  );
}

function Polymerase() {
  const ref = useRef<THREE.Mesh>(null);
  const xRef = useRef(-2);
  useFrame((_, dt) => {
    xRef.current += dt * 0.6;
    if (xRef.current > 2) xRef.current = -2;
    if (ref.current) ref.current.position.x = xRef.current;
  });
  return (
    <group>
      {Array.from({ length: 16 }, (_, i) => (
        <mesh key={i} position={[(i - 7.5) * 0.3, 0, 0]}>
          <boxGeometry args={[0.25, 0.4, 0.25]} />
          <meshStandardMaterial color="#3B82F6" emissive="#3B82F6" emissiveIntensity={0.1} />
        </mesh>
      ))}
      <mesh ref={ref} position={[-2, 0.4, 0]}>
        <sphereGeometry args={[0.45, 32, 32]} />
        <meshStandardMaterial color="#D4A574" emissive="#D4A574" emissiveIntensity={0.4} transparent opacity={0.85} />
      </mesh>
    </group>
  );
}

function Ligase() {
  const [gap1, gap2] = useState([true, true])[0];
  return (
    <group>
      {Array.from({ length: 12 }, (_, i) => {
        const skip = (gap1 && i === 4) || (gap2 && i === 7);
        return (
          <mesh key={i} position={[(i - 5.5) * 0.3, 0, 0]}>
            <boxGeometry args={[0.25, 0.4, 0.25]} />
            <meshStandardMaterial
              color={skip ? "#94A3B8" : "#3B82F6"}
              opacity={skip ? 0.3 : 1}
              transparent
            />
          </mesh>
        );
      })}
      <mesh position={[(4 - 5.5) * 0.3, 0.5, 0]}>
        <coneGeometry args={[0.2, 0.4, 16]} />
        <meshStandardMaterial color="#D4A574" emissive="#D4A574" emissiveIntensity={0.5} />
      </mesh>
    </group>
  );
}

function GenericVisual({ kind }: { kind: string }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 0.4;
  });
  if (kind === "generic_assemble") {
    return (
      <group ref={ref}>
        {[-1, 0, 1].map((x, i) => (
          <mesh key={i} position={[x * 0.7, 0, 0]}>
            <boxGeometry args={[0.5, 0.5, 0.5]} />
            <meshStandardMaterial color="#3B82F6" emissive="#3B82F6" emissiveIntensity={0.2} />
          </mesh>
        ))}
      </group>
    );
  }
  if (kind === "generic_react") {
    return (
      <group ref={ref}>
        <mesh position={[-1, 0, 0]}>
          <sphereGeometry args={[0.4, 24, 24]} />
          <meshStandardMaterial color="#3B82F6" emissive="#3B82F6" emissiveIntensity={0.3} />
        </mesh>
        <mesh position={[1, 0, 0]}>
          <sphereGeometry args={[0.4, 24, 24]} />
          <meshStandardMaterial color="#D4A574" emissive="#D4A574" emissiveIntensity={0.3} />
        </mesh>
        <mesh position={[0, 0, 0]}>
          <torusGeometry args={[0.7, 0.05, 8, 32]} />
          <meshStandardMaterial color="#94A3B8" />
        </mesh>
      </group>
    );
  }
  return (
    <group ref={ref}>
      <mesh>
        <icosahedronGeometry args={[0.8, 1]} />
        <meshStandardMaterial color="#3B82F6" emissive="#3B82F6" emissiveIntensity={0.2} wireframe />
      </mesh>
    </group>
  );
}

const VISUALS: Record<string, () => JSX.Element> = {
  split_strand: () => <SplitStrand />,
  primer_attach: () => <PrimerAttach />,
  polymerase: () => <Polymerase />,
  ligase: () => <Ligase />,
  generic_assemble: () => <GenericVisual kind="generic_assemble" />,
  generic_react: () => <GenericVisual kind="generic_react" />,
  generic_transform: () => <GenericVisual kind="generic_transform" />,
};

export default function StepwiseProcess({ blueprint }: Props) {
  const cfg = blueprint.config as StepwiseProcessConfig;
  const [stepIdx, setStepIdx] = useState(0);
  const step = cfg.steps[stepIdx];
  const Visual = VISUALS[step.visual] ?? VISUALS.generic_transform;

  return (
    <div className="space-y-4">
      <div className="relative w-full h-[340px] glass-strong overflow-hidden">
        <Canvas camera={{ position: [0, 0.5, 5], fov: 45 }} gl={{ antialias: true }} dpr={[1, 2]}>
          <color attach="background" args={["#0B1220"]} />
          <ambientLight intensity={0.5} />
          <directionalLight position={[3, 4, 5]} intensity={1} />
          <directionalLight position={[-3, 1, -2]} intensity={0.3} color="#3B82F6" />
          <Visual />
        </Canvas>
        <div className="absolute top-3 left-3 font-mono text-xs text-muted">
          step <span className="text-accent">{stepIdx + 1}</span> / {cfg.steps.length}
        </div>
      </div>

      <div className="glass p-4 sm:p-5">
        <AnimatePresence mode="wait">
          <motion.div
            key={step.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35 }}
          >
            <h3 className="font-display text-xl mb-1">{step.title}</h3>
            <p className="text-muted text-sm leading-relaxed">{step.description}</p>
          </motion.div>
        </AnimatePresence>

        <div className="flex items-center justify-between mt-4">
          <button
            className="btn-ghost"
            disabled={stepIdx === 0}
            onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
          >
            <ChevronLeft size={14} /> Back
          </button>
          <div className="flex gap-1">
            {cfg.steps.map((_, i) => (
              <button
                key={i}
                onClick={() => setStepIdx(i)}
                className={`w-2 h-2 rounded-full transition-colors ${
                  i === stepIdx ? "bg-accent" : i < stepIdx ? "bg-primary/60" : "bg-white/15"
                }`}
                aria-label={`Step ${i + 1}`}
              />
            ))}
          </div>
          <button
            className="btn-ghost"
            disabled={stepIdx === cfg.steps.length - 1}
            onClick={() => setStepIdx((i) => Math.min(cfg.steps.length - 1, i + 1))}
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
