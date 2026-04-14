# 🌀 Strange Attractors

> *"Chaos is not the absence of order. It is order so complex it looks like noise."*

A mathematical art module for [RepoScripter2](https://github.com/merrypranxter/reposcripter2). Five strange attractor engines running on the GPU — 262,144 particles, GPGPU ping-pong FBOs, additive blending, and velocity-mapped color. Designed as a context source for AI-generated generative art.

---

## The Attractor Engines

Five distinct mathematical systems, each with a different geometric soul:

| # | Name | Dims | Visual Character |
|---|------|------|-----------------|
| 0 | **Clifford** | 2D | Folded silk ribbons, moiré interference |
| 1 | **Peter de Jong** | 2D | Bioluminescent webs, deep-sea orbital maps |
| 2 | **Aizawa** | 3D | Sphere vortex, swirling cosmic apple |
| 3 | **Thomas** | 3D | Cyclic labyrinth, alien 3D lattice |
| 4 | **Lorenz** | 3D | The butterfly — the original chaos portrait |

### The Math

**Clifford** — 2D folding maps:
```
x' = sin(a·y) + c·cos(a·x)
y' = sin(b·x) + d·cos(b·y)
```

**Peter de Jong** — 2D sweeping curves:
```
x' = sin(a·y) - cos(b·x)
y' = sin(c·x) - cos(d·y)
```

**Lorenz** — The OG 3D butterfly:
```
dx/dt = σ(y - x)
dy/dt = x(ρ - z) - y
dz/dt = xy - βz
```

---

## GPU Architecture

The simulation runs entirely on the GPU using WebGL2 + Three.js:

```
Seed DataTexture (random positions)
         ↓
  FBO Ping-Pong Loop
  (GLSL update shader — runs attractor equations per-particle)
         ↓
  Particle Render Pass
  (points geometry — velocity → color mapping)
         ↓
  Decay Pass
  (previous frame × 0.97 = ghostly trails)
         ↓
  Screen Output
```

**262,144 particles** stored in a 512×512 RGBA32F texture. Each pixel = one particle: `.rgb` = position, `.a` = velocity magnitude for color.

---

## Rendering Techniques

### FBO Ping-Pong
Two render targets alternate each frame. The attractor update shader reads from target A, writes to target B, then they swap. The decay pass multiplies the previous frame by ~0.97, building up ghostly light trails that visualize the attractor's history.

### Additive Blending
`gl.blendFunc(SRC_ALPHA, ONE)` — when thousands of faint particles overlap at attractor nodes, light accumulates into blazing hot spots. Dense regions become blown-out cores; sparse regions are faint wisps.

### Velocity → Color Mapping
Particle speed (distance between frames) maps to a color gradient:
- Slow → deep indigo / bruised violet
- Medium → electric cyan / plasma blue  
- Fast → atomic green / blinding yellow-white

---

## Aesthetic Post-Processing

- **Temporal decay / Shoegaze smear** — FBO feedback with slight blur = dreamlike haze
- **Chromatic aberration** — RGB channel separation at canvas edges
- **Domain warping** — attractor output fed through Simplex noise before render = organic chaos
- **Maximalist chromatics** — electric magentas, cyan plasma, ultraviolet voids, radioactive greens

---

## Files

| File | What it is |
|------|-----------|
| `strange_attractors.js` | Full GPGPU simulation — runs inside RepoScripter2's JS5 engine |
| `repo_seed.txt` | Mathematical deep-dive: equations, rendering pipeline, aesthetic guide |
| `context.manifest.json` | RepoScripter2 file manifest |

---

## Used By

This repo is a context source for [RepoScripter2](https://github.com/merrypranxter/reposcripter2) — select it as input and generate new attractor-based art with AI.

Also part of [ShaderForge](https://github.com/merrypranxter/shaderforge3) ecosystem.

---

<div align="center">
<sub>five mathematical gods. 262,144 particles. zero stability. all beauty.</sub>
</div>
