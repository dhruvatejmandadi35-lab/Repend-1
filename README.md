# Repend

**Rep up. End with clarity.**
*Learn by doing. Not watching.*

Repend turns any topic into a hands-on learning moment. Type something you want to understand and the AI generates a short lesson, a custom 3D simulation, and a verification question — all tailored to the topic. Nothing is pre-made.

## Architecture

```
repend/
├── client/   # Vite + React + TypeScript + Three.js
├── server/   # Node.js + Express + Anthropic SDK
```

## Setup

```bash
# Install all dependencies
npm install
cd client && npm install && cd ..
cd server && npm install && cd ..

# Set your Anthropic API key
echo "ANTHROPIC_API_KEY=sk-ant-..." > server/.env

# Run both client and server in dev
npm run dev
```

Client runs on `http://localhost:5173`, server on `http://localhost:8787`.

## The Loop

1. **Topic input** — user types what they want to learn
2. **AI reasoning** — Claude picks the right pedagogy and simulation type
3. **Lesson** — a scenario-based 3-4 sentence framing
4. **Simulation** — a custom interactive 3D / chart experience
5. **Verification** — a question that requires using the simulation

## Simulation Archetypes

The AI autonomously chooses one of six archetypes per topic:

- `graph_explorer` — sliders + live chart
- `physics_object` — 3D object with real physics
- `system_diagram` — reactive node graph
- `particle_field` — many particles obeying rules
- `stepwise_process` — discrete cause-and-effect steps
- `comparison_split` — two side-by-side scenarios

## Endpoints

- `POST /api/generate` — streams reasoning, lesson, and blueprint over SSE
- `POST /api/verify` — evaluates a user answer against the simulation
