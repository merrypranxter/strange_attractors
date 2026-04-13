// ============================================================
//  STRANGE ATTRACTORS — Master Module for RepoScripter2
//  GPGPU Multi-Attractor Particle Simulation
//  WebGL2 / GLSL 3.00 ES / Three.js
//
//  Execution environment (injected by RepoScripter2 engine):
//    grid, time, repos, input, mouse, ctx, canvas, THREE
//
//  Five attractor engines on GPU:
//    0 · Clifford       — 2D folding ribbons
//    1 · Peter de Jong  — 2D bioluminescent webs
//    2 · Aizawa         — 3D sphere vortex
//    3 · Thomas         — 3D cyclic labyrinth
//    4 · Lorenz         — 3D butterfly
// ============================================================

// ─── STATE PERSISTENCE GUARD ────────────────────────────────
if (!canvas.__three) {

  const W       = canvas.width  = window.innerWidth;
  const H       = canvas.height = window.innerHeight;
  const SIM_RES = 512;          // 512×512 = 262,144 particles
  const N       = SIM_RES * SIM_RES;

  // ── WebGL2 Renderer ──────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({
    canvas,
    context: canvas.getContext('webgl2', { antialias: false }),
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, H, false);
  renderer.autoClear = false;   // critical: manual clear control for decay

  // ── Cameras ──────────────────────────────────────────────
  // Orthographic camera drives all full-screen quad passes.
  // Perspective camera renders the particle cloud.
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const partCam = new THREE.PerspectiveCamera(60, W / H, 0.01, 1000);
  partCam.position.set(0, 0, 4);
  partCam.lookAt(0, 0, 0);

  // ── FBO Ping-Pong ─────────────────────────────────────────
  // Two RGBA32F render targets store per-particle state:
  //   .rgb = world-space position   .a = smoothed speed (for color)
  const rtOpts = {
    minFilter:     THREE.NearestFilter,
    magFilter:     THREE.NearestFilter,
    format:        THREE.RGBAFormat,
    type:          THREE.FloatType,
    depthBuffer:   false,
    stencilBuffer: false,
  };
  const fbo = [
    new THREE.WebGLRenderTarget(SIM_RES, SIM_RES, rtOpts),
    new THREE.WebGLRenderTarget(SIM_RES, SIM_RES, rtOpts),
  ];

  // Shared PlaneGeometry(-1..1) for all full-screen passes
  const quadGeo = new THREE.PlaneGeometry(2, 2);

  // ── Seed Helper ───────────────────────────────────────────
  // Returns a DataTexture filled with small random positions.
  const mkSeed = () => {
    const d = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      d[i * 4    ] = (Math.random() - 0.5) * 0.1;
      d[i * 4 + 1] = (Math.random() - 0.5) * 0.1;
      d[i * 4 + 2] = (Math.random() - 0.5) * 0.1;
      d[i * 4 + 3] = 0;
    }
    const t = new THREE.DataTexture(d, SIM_RES, SIM_RES,
                                    THREE.RGBAFormat, THREE.FloatType);
    t.needsUpdate = true;
    return t;
  };

  // ── Blit Helper ───────────────────────────────────────────
  // Copies a texture into an FBO via a minimal copy shader.
  const blitToFBO = (tex, target) => {
    const mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { u_tex: { value: tex } },
      vertexShader: `
        precision highp float;
        in vec3 position;
        void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: `
        precision highp float;
        uniform sampler2D u_tex;
        out vec4 fragColor;
        void main() {
          fragColor = texture(u_tex, gl_FragCoord.xy / vec2(${SIM_RES}.0));
        }
      `,
    });
    const s = new THREE.Scene();
    s.add(new THREE.Mesh(quadGeo, mat));
    renderer.setRenderTarget(target);
    renderer.render(s, quadCam);
    renderer.setRenderTarget(null);
    mat.dispose();
    tex.dispose();
  };

  // Seed ping buffer with randomised starting positions
  blitToFBO(mkSeed(), fbo[0]);

  // ════════════════════════════════════════════════════════
  //  COMPUTE SHADER — GPGPU Multi-Attractor Engine
  //
  //  Reads particle state (pos.xyz + speed.w) from the ping
  //  FBO, advances each particle one step through the chosen
  //  attractor equation, and writes the result to the pong FBO.
  //
  //  Attractor equations
  //  ───────────────────
  //  Clifford (2D iterative map):
  //    x' = sin(a·y) + c·cos(a·x)
  //    y' = sin(b·x) + d·cos(b·y)
  //
  //  Peter de Jong (2D iterative map):
  //    x' = sin(a·y) − cos(b·x)
  //    y' = sin(c·x) − cos(d·y)
  //
  //  Aizawa (3D ODE, Euler):
  //    ẋ = (z−b)x − dy
  //    ẏ = dx + (z−b)y
  //    ż = c + az − z³/3 − (x²+y²)(1+ez) + f·z·x³
  //
  //  Thomas (3D ODE, Euler):
  //    ẋ = sin(y) − bx
  //    ẏ = sin(z) − by
  //    ż = sin(x) − bz
  //
  //  Lorenz (3D ODE, Euler):
  //    ẋ = σ(y−x)
  //    ẏ = x(ρ−z) − y
  //    ż = xy − βz
  // ════════════════════════════════════════════════════════
  const computeMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      u_posTex: { value: null },
      u_mode:   { value: 0 },
      u_params: { value: new THREE.Vector4(-1.7, 1.3, -0.5, -2.2) },
      u_dt:     { value: 0.003 },
      u_mouse:  { value: new THREE.Vector2(0, 0) },
    },
    vertexShader: /* glsl */`
      precision highp float;
      in vec3 position;
      void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */`
      precision highp float;

      uniform sampler2D u_posTex;
      uniform int       u_mode;    // attractor selector 0-4
      uniform vec4      u_params;  // a, b, c, d
      uniform float     u_dt;      // ODE timestep
      uniform vec2      u_mouse;   // normalised mouse [-1, 1]

      out vec4 fragColor;

      // ── Clifford Attractor (2D Folding Ribbons) ──────────
      // Gossamer interference patterns; highly parameter-sensitive.
      // Effective range: a,b,c,d ∈ [-3.0, 3.0]
      vec3 clifford(vec3 p, float a, float b, float c, float d) {
        return vec3(
          sin(a * p.y) + c * cos(a * p.x),
          sin(b * p.x) + d * cos(b * p.y),
          0.0
        );
      }

      // ── Peter de Jong Attractor (2D Bioluminescent Webs) ─
      // Sweeping orbital arcs; deep-sea jellyfish at high density.
      // Effective range: a,b,c,d ∈ [-3.0, 3.0]
      vec3 deJong(vec3 p, float a, float b, float c, float d) {
        return vec3(
          sin(a * p.y) - cos(b * p.x),
          sin(c * p.x) - cos(d * p.y),
          0.0
        );
      }

      // ── Aizawa Attractor (3D Sphere Vortex) ──────────────
      // Euler integration of the continuous ODE system.
      // Fixed secondary params: e=0.25, f=0.1
      // Default primary params: a=0.95 b=0.7 c=0.6 d=3.5
      vec3 aizawa(vec3 p, float a, float b, float c, float d, float dt) {
        float e = 0.25, f = 0.1;
        float x = p.x, y = p.y, z = p.z;
        return p + vec3(
          (z - b) * x - d * y,
          d * x + (z - b) * y,
          c + a * z - z * z * z / 3.0
            - (x * x + y * y) * (1.0 + e * z)
            + f * z * x * x * x
        ) * dt;
      }

      // ── Thomas' Cyclically Symmetric Attractor (3D Labyrinth) ──
      // Single dissipation coefficient b.
      // Chaotic near b ≈ 0.19; quasi-periodic at higher values.
      //   ẋ = sin(y) − bx,  ẏ = sin(z) − by,  ż = sin(x) − bz
      vec3 thomas(vec3 p, float b, float dt) {
        return p + vec3(
          sin(p.y) - b * p.x,
          sin(p.z) - b * p.y,
          sin(p.x) - b * p.z
        ) * dt;
      }

      // ── Lorenz Attractor (3D Butterfly) ──────────────────
      // Classical chaotic system. σ(y−x), x(ρ−z)−y, xy−βz.
      // Canonical params: σ=10, ρ=28, β=8/3
      vec3 lorenz(vec3 p, float sigma, float rho, float beta, float dt) {
        return p + vec3(
          sigma * (p.y - p.x),
          p.x * (rho - p.z) - p.y,
          p.x * p.y - beta * p.z
        ) * dt;
      }

      void main() {
        vec2 uv   = gl_FragCoord.xy / vec2(textureSize(u_posTex, 0));
        vec4 data = texture(u_posTex, uv);
        vec3 pos  = data.xyz;

        // Mouse shifts a and b parameters by up to ±30 %
        float a  = u_params.x * (1.0 + u_mouse.x * 0.3);
        float b  = u_params.y * (1.0 + u_mouse.y * 0.3);
        float c  = u_params.z;
        float d  = u_params.w;

        vec3 newPos;

        if (u_mode == 0) {
          // Clifford: apply 3 iterative map steps per frame for
          // faster convergence to the attractor basin
          newPos = clifford(clifford(clifford(pos, a, b, c, d), a, b, c, d), a, b, c, d);

        } else if (u_mode == 1) {
          // de Jong: same multi-step approach as Clifford
          newPos = deJong(deJong(deJong(pos, a, b, c, d), a, b, c, d), a, b, c, d);

        } else if (u_mode == 2) {
          // Aizawa ODE — a & b driven by mouse; c, d fixed
          newPos = aizawa(pos, a, b, c, d, u_dt);

        } else if (u_mode == 3) {
          // Thomas — single dissipation param a (= u_params.x)
          newPos = thomas(pos, a, u_dt);

        } else {
          // Lorenz — σ=a, ρ=b, β=c
          newPos = lorenz(pos, a, b, c, u_dt);
        }

        // Divergence guard: stochastic re-seed any particle that
        // escapes the attractor basin or produces a NaN.
        // DIVERGENCE_THRESHOLD = 40 000 = ‖pos‖² at radius 200,
        // safely exceeding every attractor's natural extent while
        // catching runaway Euler steps before they corrupt the FBO.
        const float DIVERGENCE_THRESHOLD = 40000.0;
        float mag = dot(newPos, newPos);
        if (mag > DIVERGENCE_THRESHOLD || isnan(newPos.x) || isnan(newPos.y) || isnan(newPos.z)) {
          float hx  = fract(sin(dot(uv, vec2(127.1, 311.7))) * 43758.5453);
          float hy  = fract(sin(dot(uv, vec2(269.5, 183.3))) * 43758.5453);
          float hz  = fract(sin(dot(uv, vec2(419.2, 371.9))) * 43758.5453);
          newPos    = (vec3(hx, hy, hz) - 0.5) * 0.05;
        }

        // Smooth speed (distance traveled per frame) for the color ramp
        float speed  = length(newPos - pos);
        float smooth = mix(data.w, speed, 0.15);

        fragColor = vec4(newPos, smooth);
      }
    `,
  });

  const computeScene = new THREE.Scene();
  computeScene.add(new THREE.Mesh(quadGeo, computeMat));

  // ════════════════════════════════════════════════════════
  //  RENDER PASS — GL_POINTS + Additive Blending
  //
  //  Vertex shader:  reads FBO position via the 'uv' attribute
  //                  and projects through the perspective camera.
  //  Fragment shader: Gaussian soft point kernel + Lisa Frank
  //                   maximalist chromatic ramp.
  //
  //  THREE.AdditiveBlending: thousands of faint overlapping
  //  particles accumulate into blazing hot nodes at dense loci.
  // ════════════════════════════════════════════════════════

  // Each particle maps to one FBO texel via a pre-baked UV pair.
  // 'position' attribute is left zeroed (Three.js bounding box
  // requirement); actual world positions come from the FBO sample.
  const posArr = new Float32Array(N * 3);   // zeros
  const uvArr  = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    uvArr[i * 2    ] = ((i % SIM_RES) + 0.5) / SIM_RES;
    uvArr[i * 2 + 1] = (Math.floor(i / SIM_RES) + 0.5) / SIM_RES;
  }
  const partGeo = new THREE.BufferGeometry();
  partGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  partGeo.setAttribute('uv',       new THREE.BufferAttribute(uvArr,  2));

  // THREE.ShaderMaterial auto-injects:
  //   uniforms  — projectionMatrix, modelViewMatrix, viewMatrix,
  //               modelMatrix, normalMatrix, cameraPosition
  //   attributes — position (vec3), uv (vec2), normal (vec3)
  // DO NOT redeclare any of the above in the shader source.
  const partMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      u_posTex: { value: null },
      u_mode:   { value: 0 },
    },
    vertexShader: /* glsl */`
      uniform sampler2D u_posTex;
      uniform int       u_mode;

      out float vSpeed;

      void main() {
        // 'uv' is auto-injected by Three.js ShaderMaterial.
        // Sample this particle's current position from the FBO.
        vec4 data  = texture(u_posTex, uv);
        vec3 pos   = data.xyz;
        vSpeed     = data.w;

        // Scale each attractor's natural coordinate range into
        // a common ≈ ±1.5 view-space volume.
        vec3 wp;
        if      (u_mode == 0 || u_mode == 1) wp = vec3(pos.xy * 0.32, 0.0);  // Clifford / de Jong: ±2.5 range
        else if (u_mode == 2)                 wp = pos * 0.85;                // Aizawa:             ±1.5 range
        else if (u_mode == 3)                 wp = pos * 0.28;                // Thomas:             ±4.0 range
        else                                  wp = vec3(pos.xy * 0.065,       // Lorenz: x,y ≈ ±20
                                                        (pos.z - 25.0) * 0.065); //         z ≈ 5..45

        // 'projectionMatrix' and 'modelViewMatrix' are auto-injected.
        gl_Position  = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
        gl_PointSize = 1.5;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;

      in  float vSpeed;
      out vec4  fragColor;

      // ── Lisa Frank Maximalist Chromatic Ramp ─────────────
      // Maps normalised particle speed (0→1) through a hyper-
      // saturated five-stop gradient:
      //
      //  0.00 → #0a001a  deep ultraviolet void
      //  0.25 → #ff007f  electric magenta
      //  0.50 → #9d00ff  hyper violet
      //  0.75 → #00ffff  neon cyan plasma
      //  1.00 → #fff700  blinding yellow
      //
      // Contrast is intentionally maximalist — slow particles
      // sink into near-black voids while fast nodes ignite into
      // blown-out cyan/yellow hot spots via additive accumulation.
      vec3 lisaFrank(float t) {
        t = clamp(t, 0.0, 1.0);
        vec3 c0 = vec3(0.039, 0.000, 0.102);  // deep void
        vec3 c1 = vec3(1.000, 0.000, 0.498);  // electric magenta
        vec3 c2 = vec3(0.616, 0.000, 1.000);  // hyper violet
        vec3 c3 = vec3(0.000, 1.000, 1.000);  // neon cyan plasma
        vec3 c4 = vec3(1.000, 0.969, 0.000);  // blinding yellow
        if (t < 0.25) return mix(c0, c1, t * 4.0);
        if (t < 0.50) return mix(c1, c2, (t - 0.25) * 4.0);
        if (t < 0.75) return mix(c2, c3, (t - 0.50) * 4.0);
        return           mix(c3, c4, (t - 0.75) * 4.0);
      }

      void main() {
        // Discard the corners of the gl_PointSize square to get
        // circular soft dots rather than harsh pixel squares.
        vec2  pc      = gl_PointCoord - 0.5;
        float d       = length(pc);
        if (d > 0.5) discard;

        // Gaussian falloff — produces a soft, phosphor-like glow.
        float falloff = exp(-d * d * 14.0);

        // SPEED_COLOR_SCALE: maps the per-frame displacement
        // (world-space distance ≈ 0–0.008 for typical ODE steps,
        // or ≈ 0–0.003 for iterative maps at SIM_RES=512) onto
        // the full [0,1] range of the Lisa Frank ramp.
        const float SPEED_COLOR_SCALE = 120.0;

        // PARTICLE_ALPHA_SCALE: each point is nearly invisible
        // alone (alpha ≈ 0.035 × falloff). With 262 144 particles
        // accumulating additively, dense attractor nodes blow out
        // to fully saturated colours while sparse regions stay dark.
        const float PARTICLE_ALPHA_SCALE = 0.035;

        vec3  col     = lisaFrank(clamp(vSpeed * SPEED_COLOR_SCALE, 0.0, 1.0));

        // Ultra-low alpha is critical for additive blending:
        // individual particles are nearly invisible, but thousands
        // overlapping at attractor nodes accumulate into blazing
        // saturated hot spots — the Lisa Frank money shot.
        fragColor = vec4(col, falloff * PARTICLE_ALPHA_SCALE);
      }
    `,
    blending:    THREE.AdditiveBlending,
    depthWrite:  false,
    depthTest:   false,
    transparent: true,
  });

  const points = new THREE.Points(partGeo, partMat);
  points.frustumCulled = false;   // positions live in FBO, not CPU geo

  const partScene = new THREE.Scene();
  partScene.add(points);

  // ── Temporal Decay Scene ─────────────────────────────────
  // A black quad with ~4.5 % opacity drawn over the framebuffer
  // BEFORE each particle pass.  Because renderer.autoClear = false,
  // the previous frame persists; this quad dims it each frame,
  // creating glowing, gossamer history trails.
  // DECAY_OPACITY ≈ 0.045 means a particle's trail half-life is
  // roughly log(0.5) / log(1 - 0.045) ≈ 15 frames (~0.25 s at
  // 60 fps), long enough to show the attractor topology while
  // keeping the canvas from over-saturating with stale data.
  const DECAY_OPACITY = 0.045;
  const decayScene = new THREE.Scene();
  decayScene.add(new THREE.Mesh(
    quadGeo,
    new THREE.MeshBasicMaterial({
      color:       0x000000,
      transparent: true,
      opacity:     DECAY_OPACITY,
      depthWrite:  false,
      depthTest:   false,
    })
  ));

  // ── Attractor Presets ─────────────────────────────────────
  // mode: attractor index (0-4)
  // a,b,c,d: equation parameters passed as u_params
  // dt: ODE timestep (0 = unused for iterative 2D maps)
  const PRESETS = [
    { mode: 0, name: 'clifford', a: -1.7,  b:  1.3,  c: -0.5,   d: -2.2,  dt: 0     },
    { mode: 1, name: 'dejong',   a: -2.0,  b:  1.2,  c: -1.9,   d:  2.0,  dt: 0     },
    { mode: 2, name: 'aizawa',   a:  0.95, b:  0.7,  c:  0.6,   d:  3.5,  dt: 0.003 },
    { mode: 3, name: 'thomas',   a:  0.19, b:  0.0,  c:  0.0,   d:  0.0,  dt: 0.08  },
    { mode: 4, name: 'lorenz',   a: 10.0,  b: 28.0,  c:  8 / 3, d:  0.0,  dt: 0.003 },
  ];

  // ── Persist all state on the canvas ──────────────────────
  canvas.__three = {
    renderer,
    quadCam, partCam,
    fbo,    ping: 0, pong: 1,
    computeScene, computeMat,
    partScene, partMat,
    decayScene,
    mkSeed, blitToFBO,
    PRESETS,
    currentPreset: 0,
    lastSwitch:    0,
  };

} // ─── end init ─────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════
//  ANIMATION LOOP  (executed every frame by RepoScripter2)
// ═══════════════════════════════════════════════════════════

const st = canvas.__three;
const {
  renderer, quadCam, partCam, fbo,
  computeScene, computeMat,
  partScene, partMat,
  decayScene,
  mkSeed, blitToFBO,
  PRESETS,
} = st;

// ── Attractor Hot-Swap ────────────────────────────────────
// Priority order:
//   1. input string name-lock  (e.g. "aizawa" locks to mode 2)
//   2. 8-second auto-cycle     (when input is empty / unknown)
const iStr = (input || '').toLowerCase();
let want = st.currentPreset;

if      (iStr.includes('clifford'))                          want = 0;
else if (iStr.includes('dejong') || iStr.includes('de jong')) want = 1;
else if (iStr.includes('aizawa'))                            want = 2;
else if (iStr.includes('thomas'))                            want = 3;
else if (iStr.includes('lorenz'))                            want = 4;
else if (time - st.lastSwitch > 8) {
  // Auto-cycle — advance to the next preset every 8 seconds
  want           = (st.currentPreset + 1) % PRESETS.length;
  st.lastSwitch  = time;
}

if (want !== st.currentPreset) {
  st.currentPreset = want;
  // Re-seed particles into a tight random cloud so they are
  // quickly captured by the new attractor basin
  blitToFBO(mkSeed(), fbo[st.ping]);
}

const P = PRESETS[st.currentPreset];

// ── Mouse Perturbation ────────────────────────────────────
// Normalise pointer to [-1, 1]; shifts a & b params in compute shader
const CW = canvas.width  || window.innerWidth;
const CH = canvas.height || window.innerHeight;
const mx = mouse ? (mouse.x / CW * 2 - 1) : 0;
const my = mouse ? (mouse.y / CH * 2 - 1) : 0;

// ── GPGPU Compute Pass ────────────────────────────────────
// Read from ping FBO → advance attractor → write to pong FBO
computeMat.uniforms.u_posTex.value = fbo[st.ping].texture;
computeMat.uniforms.u_mode.value   = P.mode;
computeMat.uniforms.u_params.value.set(P.a, P.b, P.c, P.d);
computeMat.uniforms.u_dt.value     = P.dt;
computeMat.uniforms.u_mouse.value.set(mx, my);

renderer.setRenderTarget(fbo[st.pong]);
renderer.render(computeScene, quadCam);
renderer.setRenderTarget(null);

// Swap ping ↔ pong
const _p = st.ping; st.ping = st.pong; st.pong = _p;

// ── Camera Orbit ──────────────────────────────────────────
// 3D attractors (Aizawa, Thomas, Lorenz) get a slow camera orbit
// so the volumetric structure is revealed from all angles.
// 2D attractors use a fixed frontal view.
if (P.mode >= 2) {
  const r = 4.0 + Math.sin(time * 0.07) * 0.6;
  partCam.position.set(
    Math.sin(time * 0.12) * r,
    Math.sin(time * 0.05) * 1.5,
    Math.cos(time * 0.12) * r
  );
  partCam.lookAt(0, 0, 0);
} else {
  partCam.position.set(0, 0, 3.5);
  partCam.lookAt(0, 0, 0);
}

// ── Render Pass ───────────────────────────────────────────
// Step 1: Draw the decay veil (orthographic, black at 4.5 % opacity)
//         This dims the previous frame, producing the temporal
//         "gossamer history trail" decay effect.
renderer.render(decayScene, quadCam);

// Step 2: Draw particles (perspective, additive blending)
//         Each call adds colour on top of the decayed frame.
partMat.uniforms.u_posTex.value = fbo[st.ping].texture;
partMat.uniforms.u_mode.value   = P.mode;
renderer.render(partScene, partCam);
