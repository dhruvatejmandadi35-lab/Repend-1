import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useInView, useReducedMotion } from "framer-motion";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  Globe,
  GraduationCap,
  Instagram,
  Twitter,
  Users,
} from "lucide-react";

/* ============================================================
   GLOBAL STYLES
   ============================================================ */

const GlobalStyles = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..900;1,9..144,400..900&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

    :root {
      --navy: #0B1220;
      --surface: #131A2A;
      --electric: #3B82F6;
      --copper: #D4A574;
      --offwhite: #F5F5F0;
      --muted: #94A3B8;
    }

    body { font-family: 'Inter', sans-serif; background: var(--navy); color: var(--offwhite); }
    .font-fraunces { font-family: 'Fraunces', serif; }
    .font-mono { font-family: 'JetBrains Mono', monospace; }
    .font-sans { font-family: 'Inter', sans-serif; }

    .liquid-glass {
      background: rgba(19, 26, 42, 0.4);
      background-blend-mode: luminosity;
      backdrop-filter: blur(16px) saturate(1.2);
      -webkit-backdrop-filter: blur(16px) saturate(1.2);
      border: none;
      box-shadow:
        inset 0 1px 1px rgba(255, 255, 255, 0.08),
        0 0 40px rgba(59, 130, 246, 0.05);
      position: relative;
      overflow: hidden;
    }
    .liquid-glass::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      padding: 1.4px;
      background: linear-gradient(180deg,
        rgba(59, 130, 246, 0.5) 0%,
        rgba(59, 130, 246, 0.15) 20%,
        rgba(255, 255, 255, 0) 40%,
        rgba(255, 255, 255, 0) 60%,
        rgba(212, 165, 116, 0.15) 80%,
        rgba(212, 165, 116, 0.45) 100%);
      -webkit-mask:
        linear-gradient(#fff 0 0) content-box,
        linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
              mask-composite: exclude;
      pointer-events: none;
    }

    .copper-glow {
      box-shadow:
        0 0 30px rgba(212, 165, 116, 0.3),
        0 0 60px rgba(212, 165, 116, 0.15);
    }
    .blue-glow {
      box-shadow:
        0 0 30px rgba(59, 130, 246, 0.4),
        0 0 80px rgba(59, 130, 246, 0.15);
    }

    /* 3D ring */
    @keyframes spin {
      from { transform: rotateX(-8deg) rotateY(0deg); }
      to   { transform: rotateX(-8deg) rotateY(360deg); }
    }
    @keyframes spin-back {
      from { transform: rotateY(0deg); }
      to   { transform: rotateY(-360deg); }
    }
    .ring-spin { animation: spin 30s linear infinite; transform-style: preserve-3d; }
    .ring-card-counter { animation: spin-back 30s linear infinite; }

    /* hero logo float */
    @keyframes float-y {
      0%,100% { transform: translateY(-8px); }
      50%     { transform: translateY(8px); }
    }
    .float-y { animation: float-y 4s ease-in-out infinite; }

    /* particle drift */
    @keyframes drift {
      0%   { transform: translate3d(0,0,0); opacity: var(--o, .3); }
      50%  { transform: translate3d(10px,-12px,0); opacity: calc(var(--o, .3) * 1.4); }
      100% { transform: translate3d(0,0,0); opacity: var(--o, .3); }
    }
    .star { animation: drift 12s ease-in-out infinite; }

    /* scanline */
    @keyframes scanline {
      0%   { transform: translateY(-10%); opacity: 0; }
      10%  { opacity: 0.15; }
      90%  { opacity: 0.15; }
      100% { transform: translateY(110%); opacity: 0; }
    }
    .scanline {
      position: absolute; left: 0; right: 0; height: 2px;
      background: linear-gradient(90deg, transparent, rgba(59,130,246,0.7), transparent);
      mix-blend-mode: screen;
      animation: scanline 8s linear infinite;
    }

    /* loop particle */
    @keyframes flow {
      0%   { offset-distance: 0%; opacity: 0; }
      10%  { opacity: 1; }
      90%  { opacity: 1; }
      100% { offset-distance: 100%; opacity: 0; }
    }

    /* pro card breathing */
    @keyframes breathe {
      0%,100% { transform: scale(1); }
      50%     { transform: scale(1.02); }
    }
    .breathe { animation: breathe 3s ease-in-out infinite; }

    /* pendulum */
    @keyframes swing {
      0%,100% { transform: rotate(-22deg); }
      50%     { transform: rotate(22deg); }
    }
    .pendulum { transform-origin: top center; animation: swing 2.4s ease-in-out infinite; }

    /* fluid */
    @keyframes wave {
      0%   { transform: translateX(0); }
      100% { transform: translateX(-50%); }
    }
    .wave-track { animation: wave 6s linear infinite; }

    /* grid drift */
    @keyframes grid-drift {
      0% { background-position: 0 0; }
      100% { background-position: 80px 80px; }
    }
    .grid-drift {
      background-image:
        linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px);
      background-size: 40px 40px;
      animation: grid-drift 20s linear infinite;
    }

    /* copper particle drift */
    @keyframes copper-drift {
      0%   { transform: translateX(-20%); opacity: 0; }
      30%  { opacity: 1; }
      70%  { opacity: 1; }
      100% { transform: translateX(120%); opacity: 0; }
    }
    .copper-drift {
      position: absolute; top: 16%; left: 0; height: 2px; width: 80px;
      background: linear-gradient(90deg, transparent, rgba(212,165,116,0.9), transparent);
      animation: copper-drift 7s ease-in-out infinite;
    }

    /* gradient mesh */
    @keyframes mesh-move {
      0%   { background-position: 0% 0%, 100% 100%; }
      50%  { background-position: 80% 30%, 20% 80%; }
      100% { background-position: 0% 0%, 100% 100%; }
    }
    .mesh {
      background:
        radial-gradient(circle at 20% 20%, rgba(212,165,116,0.12), transparent 50%),
        radial-gradient(circle at 80% 80%, rgba(59,130,246,0.12), transparent 50%);
      background-size: 200% 200%, 200% 200%;
      animation: mesh-move 14s ease-in-out infinite;
    }

    /* pulse blue */
    @keyframes pulse-blue {
      0%,100% { box-shadow: 0 0 0 rgba(59,130,246,0); }
      50%     { box-shadow: 0 0 60px rgba(59,130,246,0.18); }
    }
    .pulse-blue { animation: pulse-blue 4s ease-in-out infinite; }

    /* pulse copper */
    @keyframes pulse-copper {
      0%,100% { box-shadow: 0 0 30px rgba(212,165,116,0.25), 0 0 60px rgba(212,165,116,0.12); }
      50%     { box-shadow: 0 0 50px rgba(212,165,116,0.45), 0 0 90px rgba(212,165,116,0.2); }
    }
    .pulse-copper { animation: pulse-copper 4s ease-in-out infinite; }

    /* underline draw */
    @keyframes underline-draw {
      from { transform: scaleX(0); }
      to   { transform: scaleX(1); }
    }
    .underline-draw { transform-origin: left center; animation: underline-draw 0.9s cubic-bezier(.22,1,.36,1) forwards; }

    /* reduced motion */
    @media (prefers-reduced-motion: reduce) {
      .ring-spin, .ring-card-counter, .float-y, .star, .scanline,
      .breathe, .pendulum, .wave-track, .grid-drift, .copper-drift,
      .mesh, .pulse-blue, .pulse-copper, .underline-draw {
        animation: none !important;
      }
    }
  `}</style>
);

/* ============================================================
   REUSABLE PIECES
   ============================================================ */

const reveal = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0 },
};
const revealTrans = { duration: 0.8, ease: [0.22, 1, 0.36, 1] as const };

const useReveal = () => {
  const ref = useRef<HTMLDivElement | null>(null);
  const inView = useInView(ref, { margin: "-100px", once: true });
  return { ref, inView };
};

/* ============================================================
   STARFIELD
   ============================================================ */

const Starfield = () => {
  const stars = useMemo(
    () =>
      Array.from({ length: 40 }).map((_, i) => ({
        id: i,
        top: Math.random() * 100,
        left: Math.random() * 100,
        size: Math.random() * 2 + 1,
        opacity: 0.1 + Math.random() * 0.4,
        delay: Math.random() * 8,
      })),
    []
  );

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {stars.map((s) => (
        <span
          key={s.id}
          className="star absolute rounded-full bg-white"
          style={{
            top: `${s.top}%`,
            left: `${s.left}%`,
            width: s.size,
            height: s.size,
            opacity: s.opacity,
            ["--o" as any]: s.opacity,
            animationDelay: `${s.delay}s`,
          }}
        />
      ))}
    </div>
  );
};

/* ============================================================
   LAB CARD PREVIEWS (used in the orbiting ring)
   ============================================================ */

const PhysicsSim = () => (
  <div className="space-y-2">
    <div className="relative h-16 rounded-lg bg-black/30 overflow-hidden flex items-center justify-center">
      <svg viewBox="0 0 100 60" className="absolute inset-0 w-full h-full">
        <ellipse cx="50" cy="30" rx="38" ry="14" fill="none" stroke="rgba(212,165,116,0.4)" strokeDasharray="2 3" />
        <ellipse cx="50" cy="30" rx="38" ry="14" fill="none" stroke="rgba(59,130,246,0.35)" strokeDasharray="1 3" transform="rotate(35 50 30)" />
        <circle cx="50" cy="30" r="6" fill="#3B82F6" />
        <circle cx="88" cy="30" r="2.4" fill="#D4A574" />
      </svg>
    </div>
    <Slider label="Gravity" value={62} />
    <Slider label="Mass" value={40} />
  </div>
);

const PendulumLab = () => (
  <div className="space-y-2">
    <div className="relative h-16 rounded-lg bg-black/30 overflow-hidden">
      <div className="absolute left-1/2 top-0 -translate-x-1/2 h-full">
        <div className="pendulum origin-top relative">
          <div className="mx-auto w-px h-12 bg-white/40" />
          <div className="mx-auto -mt-1 h-3 w-3 rounded-full bg-[#D4A574]" />
        </div>
      </div>
    </div>
    <InputRow label="Length" value="1.2 m" />
  </div>
);

const CircuitBuilder = () => (
  <div className="space-y-2">
    <div className="relative h-16 rounded-lg bg-black/30 overflow-hidden flex items-center justify-center">
      <svg viewBox="0 0 100 60" className="w-full h-full">
        <path d="M10 30 H35 M45 30 H65 M75 30 H90 M10 30 V50 H90 V30" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="1.4" />
        <rect x="35" y="26" width="10" height="8" fill="none" stroke="#3B82F6" strokeWidth="1.4" />
        <circle cx="70" cy="30" r="5" fill="#D4A574" opacity="0.9">
          <animate attributeName="opacity" values="0.5;1;0.5" dur="2s" repeatCount="indefinite" />
        </circle>
      </svg>
    </div>
    <Slider label="Voltage" value={70} />
  </div>
);

const DampedOscillation = () => (
  <div className="space-y-2">
    <div className="relative h-16 rounded-lg bg-black/30 overflow-hidden">
      <svg viewBox="0 0 200 60" preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
        <path d="M0 30 Q 12 8 24 30 T 48 30 T 72 30 T 96 30 T 120 30 T 144 30 T 168 30 T 192 30"
              fill="none" stroke="#3B82F6" strokeWidth="1.5" opacity="0.8" />
        <path d="M0 30 Q 12 18 24 30 T 48 30 T 72 28 T 96 30 T 120 30 T 144 30 T 168 30 T 192 30"
              fill="none" stroke="#D4A574" strokeWidth="1" opacity="0.5" strokeDasharray="2 2" />
      </svg>
    </div>
    <Slider label="Damping" value={45} />
  </div>
);

const FluidFlow = () => (
  <div className="space-y-2">
    <div className="relative h-16 rounded-lg bg-black/30 overflow-hidden">
      <div className="absolute inset-0 flex flex-col justify-around">
        {[0, 1, 2].map((i) => (
          <div key={i} className="overflow-hidden">
            <div className="wave-track flex w-[200%]">
              <svg viewBox="0 0 200 12" className="h-3 w-full">
                <path d="M0 6 Q 25 0 50 6 T 100 6 T 150 6 T 200 6"
                      fill="none" stroke="rgba(59,130,246,0.6)" strokeWidth="1.2" />
              </svg>
              <svg viewBox="0 0 200 12" className="h-3 w-full">
                <path d="M0 6 Q 25 0 50 6 T 100 6 T 150 6 T 200 6"
                      fill="none" stroke="rgba(59,130,246,0.6)" strokeWidth="1.2" />
              </svg>
            </div>
          </div>
        ))}
      </div>
      <div className="absolute bottom-1 right-2 font-mono text-[10px] text-[#D4A574]">2.3 m/s</div>
    </div>
  </div>
);

const VariablesCard = () => (
  <div className="space-y-2">
    <Slider label="Damping" value={55} />
    <Slider label="Mass" value={32} />
    <Slider label="Stiffness" value={78} />
  </div>
);

const Slider = ({ label, value }: { label: string; value: number }) => (
  <div className="text-[10px]">
    <div className="flex justify-between text-white/60 font-mono mb-1">
      <span>{label}</span>
      <span>{value}</span>
    </div>
    <div className="h-1 rounded-full bg-white/10 overflow-hidden">
      <div className="h-full rounded-full bg-gradient-to-r from-[#3B82F6] to-[#D4A574]" style={{ width: `${value}%` }} />
    </div>
  </div>
);

const InputRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between rounded-md bg-white/5 px-2 py-1 text-[10px] font-mono">
    <span className="text-white/60">{label}</span>
    <span className="text-[#D4A574]">{value}</span>
  </div>
);

const LAB_CARDS = [
  { title: "Physics Sim", body: <PhysicsSim /> },
  { title: "Pendulum Lab", body: <PendulumLab /> },
  { title: "Circuit Builder", body: <CircuitBuilder /> },
  { title: "Damped Oscillation", body: <DampedOscillation /> },
  { title: "Fluid Flow", body: <FluidFlow /> },
  { title: "Variables", body: <VariablesCard /> },
];

/* ============================================================
   NAVBAR
   ============================================================ */

const Navbar = () => (
  <div className="fixed left-0 right-0 top-0 z-20 mt-4 px-4">
    <div className="liquid-glass mx-auto flex max-w-[1100px] items-center justify-between rounded-full px-5 py-2.5">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <Globe size={16} className="text-[#D4A574]" />
          <span className="font-fraunces text-lg">Repend</span>
        </div>
        <nav className="hidden md:flex items-center gap-5 text-sm text-white/70">
          <a className="hover:text-white" href="#how">How It Works</a>
          <a className="hover:text-white" href="#pricing">Pricing</a>
          <a className="hover:text-white" href="#manifesto">Manifesto</a>
        </nav>
      </div>
      <div className="flex items-center gap-3">
        <a className="text-sm text-white/70 hover:text-white hidden sm:inline" href="#signin">Sign In</a>
        <button className="liquid-glass copper-glow rounded-full px-4 py-1.5 text-sm font-medium text-white">
          Try Free
        </button>
      </div>
    </div>
  </div>
);

/* ============================================================
   HERO
   ============================================================ */

const Hero = () => {
  const reduced = useReducedMotion();
  return (
    <section className="relative flex min-h-screen flex-col overflow-hidden">
      {/* background */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 0%, rgba(59,130,246,0.12) 0%, transparent 70%), linear-gradient(180deg, #0B1220 0%, #0B1220 100%)",
        }}
      />
      <Starfield />
      <Navbar />

      <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 pt-28 pb-24 text-center">
        {/* 3D centerpiece — desktop */}
        <div className="relative hidden md:block" style={{ perspective: "1500px" }}>
          <div
            className={`relative h-[420px] w-[420px] ${reduced ? "" : "ring-spin"}`}
            style={{ transformStyle: "preserve-3d" }}
          >
            {/* central logo */}
            <div className="absolute inset-0 flex items-center justify-center" style={{ transform: "translateZ(0)" }}>
              <h2
                className={`font-fraunces font-bold text-[6rem] leading-none text-[#3B82F6] ${reduced ? "" : "float-y"}`}
                style={{ textShadow: "0 0 22px rgba(212,165,116,0.55), 0 0 4px rgba(212,165,116,0.4)" }}
              >
                Repend
              </h2>
            </div>

            {/* orbiting cards */}
            {LAB_CARDS.map((c, i) => {
              const angle = i * 60;
              return (
                <div
                  key={c.title}
                  className="absolute left-1/2 top-1/2 w-48"
                  style={{
                    transform: `translate(-50%, -50%) rotateY(${angle}deg) translateZ(280px)`,
                    transformStyle: "preserve-3d",
                  }}
                >
                  <div className={reduced ? "" : "ring-card-counter"} style={{ transformStyle: "preserve-3d" }}>
                    <div className="liquid-glass rounded-2xl p-4">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="font-mono text-[10px] uppercase tracking-widest text-[#D4A574]">
                          Lab
                        </span>
                        <span className="font-fraunces text-sm">{c.title}</span>
                      </div>
                      {c.body}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Mobile fallback */}
        <div className="md:hidden mb-10 w-full max-w-xs">
          <h2 className="font-fraunces font-bold text-5xl text-[#3B82F6] mb-6 text-center"
              style={{ textShadow: "0 0 18px rgba(212,165,116,0.5)" }}>
            Repend
          </h2>
          <div className="liquid-glass rounded-2xl p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-widest text-[#D4A574]">Lab</span>
              <span className="font-fraunces text-sm">Physics Sim</span>
            </div>
            <PhysicsSim />
          </div>
        </div>

        {/* Copy */}
        <div className="mt-2 md:-mt-4">
          <p className="text-xs tracking-[0.25em] uppercase text-[#D4A574] mb-6">AI-NATIVE LEARNING</p>
          <h1 className="font-fraunces font-bold text-5xl sm:text-6xl md:text-7xl lg:text-8xl xl:text-9xl leading-[0.95]">
            Learn by doing.{" "}
            <em className="italic font-fraunces text-[#94A3B8]">Not watching.</em>
          </h1>
          <p className="mx-auto mt-6 max-w-[52ch] text-lg text-white/70">
            Type any topic. Repend builds you a course, a video, and a working lab — so you actually understand it.
          </p>

          {/* Email pill */}
          <div className="mx-auto mt-8 flex w-full max-w-md items-center gap-2">
            <div className="liquid-glass flex w-full items-center rounded-full px-2 py-2">
              <input
                type="email"
                placeholder="your@email.com"
                className="flex-1 bg-transparent px-4 py-2 text-sm text-white placeholder-white/40 outline-none"
              />
              <button
                aria-label="Submit email"
                className="ml-2 grid h-9 w-9 place-items-center rounded-full bg-[#3B82F6] blue-glow text-white hover:bg-[#2563eb] transition"
              >
                <ArrowRight size={16} />
              </button>
            </div>
          </div>
          <div className="mt-4">
            <button className="liquid-glass rounded-full px-6 py-2 text-sm text-white/80 hover:text-white">
              Read the Manifesto
            </button>
          </div>
        </div>
      </div>

      {/* Hero footer icons */}
      <div className="relative z-10 flex items-center justify-center gap-3 pb-10">
        {[Twitter, Globe, Instagram].map((Icon, i) => (
          <button
            key={i}
            className="liquid-glass grid h-10 w-10 place-items-center rounded-full text-white/70 hover:text-white"
            aria-label="social link"
          >
            <Icon size={16} />
          </button>
        ))}
      </div>
    </section>
  );
};

/* ============================================================
   ABOUT
   ============================================================ */

const About = () => {
  const { ref, inView } = useReveal();
  return (
    <section
      ref={ref}
      className="relative px-6 py-32"
      style={{
        background:
          "radial-gradient(ellipse at top, rgba(59,130,246,0.04) 0%, transparent 70%)",
      }}
    >
      <div className="mx-auto max-w-5xl text-center">
        <motion.p
          initial="hidden"
          animate={inView ? "visible" : "hidden"}
          variants={reveal}
          transition={revealTrans}
          className="text-xs tracking-[0.3em] uppercase text-[#D4A574]"
        >
          About Repend
        </motion.p>
        <motion.h2
          initial="hidden"
          animate={inView ? "visible" : "hidden"}
          variants={reveal}
          transition={{ ...revealTrans, delay: 0.1 }}
          className="mt-8 font-fraunces text-4xl sm:text-5xl md:text-6xl lg:text-7xl leading-[1.05]"
        >
          Pioneering <em className="italic font-fraunces text-white/60">tools</em> for
          <br />
          minds that{" "}
          <em className="italic font-fraunces text-white/60">question, build, and master.</em>
        </motion.h2>
        <motion.p
          initial="hidden"
          animate={inView ? "visible" : "hidden"}
          variants={reveal}
          transition={{ ...revealTrans, delay: 0.2 }}
          className="mx-auto mt-12 max-w-[42ch] text-xl text-white/60"
        >
          Most learning apps make you watch. Repend makes you build.
        </motion.p>
      </div>
    </section>
  );
};

/* ============================================================
   THE LOOP (featured video replacement)
   ============================================================ */

const LoopSection = () => {
  const { ref, inView } = useReveal();
  const reduced = useReducedMotion();

  return (
    <section ref={ref} id="how" className="relative px-6 pb-24">
      <motion.div
        initial="hidden"
        animate={inView ? "visible" : "hidden"}
        variants={reveal}
        transition={revealTrans}
        className="liquid-glass relative mx-auto max-w-6xl aspect-video rounded-3xl overflow-hidden"
      >
        {/* loop content */}
        <div className="relative h-full w-full p-6 sm:p-10">
          {/* stages */}
          <div className="relative grid h-full grid-cols-3 items-center gap-4">
            {/* Course */}
            <LoopStage title="Course" subtitle="3 lessons · 12 min">
              <div className="space-y-1.5">
                {["Intro", "Concepts", "Practice"].map((t, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px] text-white/70">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#3B82F6]" />
                    <span>{t}</span>
                  </div>
                ))}
              </div>
            </LoopStage>

            {/* Video */}
            <LoopStage title="Video" subtitle="35s animated">
              <div className="relative h-16 rounded-lg bg-black/30 overflow-hidden grid place-items-center">
                <div className="grid h-8 w-8 place-items-center rounded-full bg-[#D4A574]/90 text-[#0B1220]">
                  ▶
                </div>
                <div className="absolute bottom-1 left-1 right-1 h-0.5 bg-white/10">
                  <div className="h-full w-1/3 bg-[#D4A574]" />
                </div>
              </div>
            </LoopStage>

            {/* Lab */}
            <LoopStage title="Lab" subtitle="Interactive">
              <div className="space-y-1.5">
                <Slider label="Param A" value={64} />
                <Slider label="Param B" value={28} />
              </div>
            </LoopStage>

            {/* arrows + flowing particle */}
            <ArrowsAndParticle reduced={!!reduced} />
          </div>
        </div>

        {/* Bottom overlay */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col gap-4 p-4 sm:flex-row sm:items-end sm:justify-between sm:p-6">
          <div className="liquid-glass pointer-events-auto max-w-md rounded-2xl p-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-[#D4A574]">The Loop</p>
            <p className="mt-2 text-sm text-white/80">
              Type a topic. Get a course, a video, and a working lab. All generated fresh.
            </p>
          </div>
          <button className="liquid-glass copper-glow pointer-events-auto rounded-full px-5 py-2.5 text-sm text-white">
            See it work
          </button>
        </div>
      </motion.div>
    </section>
  );
};

const LoopStage = ({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) => (
  <div className="liquid-glass rounded-2xl p-4">
    <div className="mb-3 flex items-center justify-between">
      <span className="font-fraunces text-lg">{title}</span>
      <span className="font-mono text-[10px] text-white/50">{subtitle}</span>
    </div>
    {children}
  </div>
);

const ArrowsAndParticle = ({ reduced }: { reduced: boolean }) => (
  <svg
    className="pointer-events-none absolute inset-0 h-full w-full"
    viewBox="0 0 900 300"
    preserveAspectRatio="none"
  >
    <defs>
      <linearGradient id="cop" x1="0" x2="1">
        <stop offset="0" stopColor="rgba(212,165,116,0)" />
        <stop offset="0.5" stopColor="rgba(212,165,116,0.7)" />
        <stop offset="1" stopColor="rgba(212,165,116,0)" />
      </linearGradient>
    </defs>
    {/* arrow 1 */}
    <path id="arrow1" d="M 285 150 C 320 150, 340 150, 375 150" fill="none" stroke="url(#cop)" strokeWidth="1.5" />
    <polygon points="372,145 382,150 372,155" fill="rgba(212,165,116,0.7)" />
    {/* arrow 2 */}
    <path id="arrow2" d="M 585 150 C 620 150, 640 150, 675 150" fill="none" stroke="url(#cop)" strokeWidth="1.5" />
    <polygon points="672,145 682,150 672,155" fill="rgba(212,165,116,0.7)" />

    {!reduced && (
      <>
        <circle r="3" fill="#D4A574">
          <animateMotion dur="2s" repeatCount="indefinite" begin="0s" path="M 285 150 C 320 150, 340 150, 375 150" />
          <animate attributeName="opacity" values="0;1;1;0" dur="2s" repeatCount="indefinite" />
        </circle>
        <circle r="3" fill="#D4A574">
          <animateMotion dur="2s" repeatCount="indefinite" begin="2s" path="M 585 150 C 620 150, 640 150, 675 150" />
          <animate attributeName="opacity" values="0;1;1;0" dur="2s" repeatCount="indefinite" begin="2s" />
        </circle>
      </>
    )}
  </svg>
);

/* ============================================================
   BENTO PHILOSOPHY
   ============================================================ */

const Bento = () => {
  const { ref, inView } = useReveal();
  return (
    <section ref={ref} className="relative px-6 py-24">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <motion.div
          initial="hidden"
          animate={inView ? "visible" : "hidden"}
          variants={reveal}
          transition={revealTrans}
          className="mb-12 flex flex-col items-start gap-6 md:flex-row md:items-end md:justify-between"
        >
          <div>
            <h2 className="font-fraunces text-4xl md:text-6xl">
              Hi, we built <span className="font-fraunces italic text-[#D4A574]">Repend!</span>
            </h2>
            <p className="mt-4 max-w-xl text-white/60">
              Six things we believe about how people actually learn.
            </p>
          </div>
          <button className="rounded-full bg-[#D4A574] copper-glow px-6 py-3 text-sm font-medium text-[#0B1220] hover:brightness-110">
            Start Learning
          </button>
        </motion.div>

        {/* Grid */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-5">
          {/* COL 1 - SCIENCE */}
          <motion.div
            initial="hidden" animate={inView ? "visible" : "hidden"}
            variants={reveal} transition={{ ...revealTrans, delay: 0.05 }}
            className="liquid-glass relative h-[600px] overflow-hidden rounded-[2rem] p-8 lg:col-span-4"
          >
            <div className="scanline" />
            <div className="relative z-10 flex h-full flex-col">
              <p className="font-mono text-[10px] uppercase tracking-widest text-[#D4A574]">WHY IT WORKS</p>
              <h3 className="mt-4 font-fraunces text-3xl md:text-4xl leading-tight">
                Built on retrieval, spacing, and interleaving.
              </h3>
              <div className="mt-auto space-y-4">
                <Stat label="retention vs passive review" value="+47%" />
                <Stat label="average time to first lab" value="4 sec" />
                <Stat label="generated · 0% pre-made" value="100%" />
              </div>
            </div>
          </motion.div>

          {/* COL 2 stacked */}
          <div className="space-y-4 lg:space-y-5 lg:col-span-3">
            <motion.div
              initial="hidden" animate={inView ? "visible" : "hidden"}
              variants={reveal} transition={{ ...revealTrans, delay: 0.1 }}
              className="liquid-glass relative overflow-hidden rounded-[2rem] p-6"
              style={{ minHeight: 292 }}
            >
              <div className="copper-drift" />
              <div
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    "radial-gradient(circle at 70% 30%, rgba(212,165,116,0.18), transparent 60%)",
                }}
              />
              <div className="relative z-10">
                <p className="font-mono text-[10px] uppercase tracking-widest text-[#D4A574]">STUDENT VOICE</p>
                <p className="mt-3 font-fraunces italic text-xl text-white/90 leading-snug">
                  “I finally understood why supply curves slope upward. In 90 seconds.”
                </p>
                <p className="mt-4 font-mono text-xs text-white/60">— Maya, 11th grade</p>
              </div>
            </motion.div>

            <motion.div
              initial="hidden" animate={inView ? "visible" : "hidden"}
              variants={reveal} transition={{ ...revealTrans, delay: 0.15 }}
              className="liquid-glass relative overflow-hidden rounded-[2rem] p-6 pulse-blue"
              style={{ minHeight: 292 }}
            >
              <div
                className="pointer-events-none absolute inset-0"
                style={{ background: "radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 0%, rgba(0,0,0,0.5) 80%)" }}
              />
              <div className="relative z-10 flex h-full flex-col items-center justify-center text-center">
                <p className="font-fraunces text-7xl md:text-8xl text-[#D4A574] leading-none">10x</p>
                <p className="mt-4 max-w-[18ch] text-sm text-white/60">
                  Faster than building a course manually
                </p>
              </div>
            </motion.div>
          </div>

          {/* COL 3 - SIMULATION promise + 11 LAB TYPES */}
          <motion.div
            initial="hidden" animate={inView ? "visible" : "hidden"}
            variants={reveal} transition={{ ...revealTrans, delay: 0.2 }}
            className="liquid-glass relative overflow-hidden rounded-[2rem] p-8 lg:col-span-5"
          >
            <div className="grid-drift pointer-events-none absolute inset-0 opacity-40" />
            <div className="relative z-10 flex h-full flex-col">
              <p className="font-mono text-[10px] uppercase tracking-widest text-[#D4A574]">11 LAB TYPES</p>
              <h3 className="mt-4 font-fraunces text-3xl md:text-4xl leading-tight max-w-md">
                Type in what you want to learn and get a simulation.
              </h3>

              <div className="mt-8 grid flex-1 grid-cols-3 gap-2 sm:grid-cols-4">
                {[
                  "Physics",
                  "Pendulum",
                  "Circuit",
                  "Damping",
                  "Fluid",
                  "Optics",
                  "Waves",
                  "Chem",
                  "Bio",
                  "Stats",
                  "Econ",
                ].map((t, i) => (
                  <LabTile key={t} label={t} delay={(i % 6) * 0.6} />
                ))}
              </div>
            </div>
          </motion.div>

          {/* CONTACT */}
          <motion.div
            initial="hidden" animate={inView ? "visible" : "hidden"}
            variants={reveal} transition={{ ...revealTrans, delay: 0.25 }}
            className="liquid-glass relative overflow-hidden rounded-[2rem] p-8 lg:col-span-12"
          >
            <div className="mesh pointer-events-none absolute inset-0 opacity-80" />
            <div className="relative z-10 flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-widest text-[#D4A574]">CONTACT</p>
                <p className="mt-3 font-fraunces text-3xl text-white">hi@repend.com</p>
                <p className="mt-2 max-w-xl text-white/60">
                  Building something? Teaching something? Let’s talk.
                </p>
              </div>
              <a
                href="mailto:hi@repend.com"
                className="group grid h-12 w-12 place-items-center rounded-full liquid-glass text-white/80 hover:text-white hover:copper-glow transition"
                aria-label="Contact"
              >
                <ArrowUpRight size={18} className="transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
              </a>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
};

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div className="flex items-baseline gap-3">
      <span className="font-fraunces text-3xl text-[#D4A574]">{value}</span>
      <span className="text-sm text-white/60">{label}</span>
    </div>
    <div className="mt-2 h-px w-full bg-white/10">
      <div className="h-px w-2/3 bg-gradient-to-r from-[#D4A574] to-transparent underline-draw" />
    </div>
  </div>
);

const LabTile = ({ label, delay }: { label: string; delay: number }) => (
  <div
    className="relative aspect-square rounded-xl bg-white/[0.04] flex items-center justify-center text-xs text-white/70 overflow-hidden"
    style={{ animation: `pulse-blue 6s ease-in-out ${delay}s infinite` }}
  >
    <span className="relative z-10">{label}</span>
    <div
      className="absolute inset-0"
      style={{
        background:
          "radial-gradient(circle at 50% 50%, rgba(59,130,246,0.18), transparent 60%)",
        animation: `pulse-blue 6s ease-in-out ${delay}s infinite`,
      }}
    />
  </div>
);

/* ============================================================
   BUILT FOR
   ============================================================ */

const BuiltFor = () => {
  const { ref, inView } = useReveal();
  const cards = [
    {
      Icon: GraduationCap,
      title: "Students",
      copy: "Master any subject with hands-on practice that connects to the real world.",
      bg: <div className="grid-drift pointer-events-none absolute inset-0 opacity-30" />,
    },
    {
      Icon: BookOpen,
      title: "Lifelong Learners",
      copy: "Learn anything — from finance to physics to coding — the right way.",
      bg: <div className="copper-drift" />,
    },
    {
      Icon: Users,
      title: "Educators",
      copy: "Generate custom interactive labs for your classroom in seconds.",
      bg: (
        <div
          className="pointer-events-none absolute inset-0 pulse-blue"
          style={{
            background:
              "radial-gradient(circle at 50% 50%, rgba(59,130,246,0.15), transparent 70%)",
          }}
        />
      ),
    },
  ];

  return (
    <section ref={ref} className="relative px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <motion.p
          initial="hidden" animate={inView ? "visible" : "hidden"}
          variants={reveal} transition={revealTrans}
          className="text-xs uppercase tracking-[0.3em] text-[#D4A574]"
        >
          Built for
        </motion.p>
        <motion.h2
          initial="hidden" animate={inView ? "visible" : "hidden"}
          variants={reveal} transition={{ ...revealTrans, delay: 0.1 }}
          className="mt-4 font-fraunces text-4xl md:text-6xl"
        >
          Three kinds of learners.
        </motion.h2>

        <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-3">
          {cards.map((c, i) => (
            <motion.div
              key={c.title}
              initial="hidden" animate={inView ? "visible" : "hidden"}
              variants={reveal} transition={{ ...revealTrans, delay: 0.15 + i * 0.1 }}
              whileHover={{ scale: 1.02 }}
              className="liquid-glass group relative overflow-hidden rounded-3xl p-7 hover:copper-glow transition-shadow"
            >
              {c.bg}
              <div className="relative z-10 flex flex-col gap-5">
                <div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#3B82F6]/15 text-[#3B82F6] transition group-hover:rotate-[360deg] duration-[1200ms]">
                  <c.Icon size={22} />
                </div>
                <h3 className="font-fraunces text-2xl">{c.title}</h3>
                <p className="text-sm text-white/65">{c.copy}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

/* ============================================================
   PRICING
   ============================================================ */

const Pricing = () => {
  const { ref, inView } = useReveal();

  const Feature = ({ children }: { children: React.ReactNode }) => (
    <li className="flex items-start gap-2 text-sm text-white/75">
      <Check size={14} className="mt-1 text-[#D4A574]" />
      <span>{children}</span>
    </li>
  );

  return (
    <section ref={ref} id="pricing" className="relative px-6 py-24">
      <div className="mx-auto max-w-6xl text-center">
        <motion.p
          initial="hidden" animate={inView ? "visible" : "hidden"}
          variants={reveal} transition={revealTrans}
          className="text-xs uppercase tracking-[0.3em] text-[#D4A574]"
        >
          Pricing
        </motion.p>
        <motion.h2
          initial="hidden" animate={inView ? "visible" : "hidden"}
          variants={reveal} transition={{ ...revealTrans, delay: 0.1 }}
          className="mt-4 font-fraunces text-4xl md:text-6xl"
        >
          Start free. Go deeper when you’re ready.
        </motion.h2>

        <div className="mt-14 grid grid-cols-1 gap-5 md:grid-cols-3 items-end">
          {/* Free */}
          <motion.div
            initial="hidden" animate={inView ? "visible" : "hidden"}
            variants={reveal} transition={{ ...revealTrans, delay: 0.15 }}
            whileHover={{ y: -8 }}
            className="liquid-glass rounded-3xl p-7 text-left"
          >
            <p className="font-mono text-xs tracking-widest text-white/60">FREE</p>
            <p className="mt-3 font-fraunces text-4xl">$0</p>
            <ul className="mt-6 space-y-2">
              <Feature>3 courses per month</Feature>
              <Feature>Core lab types</Feature>
              <Feature>Community challenges</Feature>
              <Feature>No credit card</Feature>
            </ul>
            <button className="mt-8 w-full rounded-full border border-white/20 px-5 py-2.5 text-sm text-white/90 hover:bg-white/5">
              Get Started
            </button>
          </motion.div>

          {/* Pro */}
          <motion.div
            initial="hidden" animate={inView ? "visible" : "hidden"}
            variants={reveal} transition={{ ...revealTrans, delay: 0.2 }}
            whileHover={{ y: -8 }}
            className="liquid-glass relative rounded-3xl p-8 text-left pulse-blue breathe md:scale-[1.04]"
          >
            <div
              aria-hidden
              className="absolute left-6 right-6 -top-px h-px bg-gradient-to-r from-transparent via-[#D4A574] to-transparent"
            />
            <p className="font-mono text-xs tracking-widest text-[#D4A574]">PRO</p>
            <p className="mt-3 font-fraunces text-4xl">
              $5.99<span className="text-base text-white/50">/mo</span>
            </p>
            <ul className="mt-6 space-y-2">
              <Feature>10 courses per month</Feature>
              <Feature>All 11 lab types</Feature>
              <Feature>Remotion video summaries</Feature>
              <Feature>AI Tutor access</Feature>
              <Feature>Priority generation</Feature>
            </ul>
            <button className="mt-8 w-full rounded-full bg-[#3B82F6] px-5 py-3 text-sm font-medium text-white blue-glow hover:bg-[#2563eb]">
              Start Pro
            </button>
          </motion.div>

          {/* Elite */}
          <motion.div
            initial="hidden" animate={inView ? "visible" : "hidden"}
            variants={reveal} transition={{ ...revealTrans, delay: 0.25 }}
            whileHover={{ y: -8 }}
            className="liquid-glass rounded-3xl p-7 text-left md:max-w-[88%] md:justify-self-end"
          >
            <p className="font-mono text-xs tracking-widest text-[#D4A574]">ELITE</p>
            <p className="mt-3 font-fraunces text-4xl">
              $9.99<span className="text-base text-white/50">/mo</span>
            </p>
            <ul className="mt-6 space-y-2">
              <Feature>Unlimited courses</Feature>
              <Feature>Everything in Pro</Feature>
              <Feature>Fastest generation</Feature>
              <Feature>Early access features</Feature>
            </ul>
            <button className="mt-8 w-full rounded-full bg-[#D4A574] copper-glow px-5 py-2.5 text-sm font-medium text-[#0B1220] hover:brightness-110">
              Go Elite
            </button>
          </motion.div>
        </div>
      </div>
    </section>
  );
};

/* ============================================================
   FINAL CTA
   ============================================================ */

const FinalCTA = () => {
  const { ref, inView } = useReveal();
  const words = ["Stop", "reviewing.", "Start", "doing."];
  return (
    <section ref={ref} id="manifesto" className="relative px-6 py-32 text-center">
      <div className="mx-auto max-w-5xl">
        <h2 className="font-fraunces text-5xl md:text-7xl lg:text-8xl leading-[1.05]">
          {words.map((w, i) => {
            const isItalic = i >= 2;
            return (
              <motion.span
                key={i}
                initial={{ opacity: 0, y: 16, filter: "blur(6px)" }}
                animate={inView ? { opacity: 1, y: 0, filter: "blur(0px)" } : {}}
                transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: i * 0.18 }}
                className={
                  isItalic
                    ? "italic font-fraunces text-[#D4A574]"
                    : "font-fraunces"
                }
                style={isItalic ? { textShadow: "0 0 25px rgba(212,165,116,0.35)" } : undefined}
              >
                {w}
                {i < words.length - 1 ? " " : ""}
              </motion.span>
            );
          })}
        </h2>
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6, delay: 0.85 }}
          className="mt-6 text-white/65"
        >
          Free forever for your first three loops.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6, delay: 1 }}
          className="mt-10"
        >
          <button className="liquid-glass pulse-copper group inline-flex items-center gap-2 rounded-full px-10 py-5 text-xl text-white">
            Start Free
            <ArrowRight size={20} className="transition group-hover:translate-x-1" />
          </button>
        </motion.div>
        <p className="mt-8 text-xs tracking-[0.3em] text-white/40">REP UP. END WITH CLARITY.</p>
      </div>
    </section>
  );
};

/* ============================================================
   FOOTER
   ============================================================ */

const Footer = () => (
  <footer
    className="px-6 py-6"
    style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
  >
    <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 text-sm text-white/40 sm:flex-row">
      <span className="font-fraunces text-lg text-white/60">Repend</span>
      <div className="flex items-center gap-3">
        <a href="#privacy" className="hover:text-white/70">Privacy</a>
        <span>·</span>
        <a href="#terms" className="hover:text-white/70">Terms</a>
        <span>·</span>
        <a href="#contact" className="hover:text-white/70">Contact</a>
      </div>
      <span>Built by Dhruvatej Reddy Mandadi</span>
    </div>
  </footer>
);

/* ============================================================
   APP
   ============================================================ */

export default function App() {
  // tiny first-paint guarantee
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div className="min-h-screen bg-[#0B1220] text-[#F5F5F0]">
      <GlobalStyles />
      <Hero />
      <About />
      <LoopSection />
      <Bento />
      <BuiltFor />
      <Pricing />
      <FinalCTA />
      <Footer />
      {/* placeholder so SSR/CSR mismatch never strips animations */}
      {mounted ? null : null}
    </div>
  );
}
