/**
 * B-62 — StellarGraph: the 3D renderer wrapper.
 *
 * Isolation contract: this is the ONLY file that imports
 * `react-force-graph-3d` and `three`. The page shell (`StellarView`) can
 * be swapped to a different renderer without touching the data model.
 *
 * Recipe (per the brief):
 *   - Engine: react-force-graph-3d (production-grade three.js wrapper).
 *   - Bloom: UnrealBloomPass via EffectComposer
 *     strength 1.7, radius 0.55, threshold 0.15.
 *   - Background: pure black (#000) for max bloom contrast.
 *   - Starfield: ~4000 inert dots on a large invisible sphere, slow rotation.
 *   - Nodes: size ∝ weight (source-count analogue), color by cluster.
 *   - Edges: typed colors for synthetic / single accent for real.
 *   - Camera: orbit + damping + slow autoRotate when idle.
 *
 * Tests do NOT exercise this file — vitest jsdom can't render canvas.
 * The page component (`StellarView`) wraps it via dynamic-import so SSR
 * does not try to mount three.js on the Node side.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import {
  CLUSTER_PALETTE,
  EDGE_COLORS,
  type StellarGraphData,
  type StellarLink,
  type StellarNode,
} from '@/lib/syntheticGraph';

// react-force-graph-3d is a client-only module. Importing it directly from
// page code makes Next try to evaluate three.js on the server at build time
// and explode. Dynamic import + ssr:false is the canonical fix.
//
// The library's typings are written against a particular NodeObject shape
// (id?: string | number, …) that doesn't agree with our augmented StellarNode
// once we attach `cluster`, `weight`, `subject`, etc. Rather than fight the
// typings on every prop, we cast the lazy component to a permissive
// signature; the runtime contract is exercised by the smoke + visual check.
const ForceGraph3DLazy = dynamic(() => import('react-force-graph-3d'), {
  ssr: false,
  loading: () => (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#000',
        color: '#3fe0c6',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 13,
      }}
    >
      별자리 점화 중…
    </div>
  ),
});
const ForceGraph3D = ForceGraph3DLazy as unknown as React.ComponentType<Record<string, unknown>>;

const ACCENT = '#3fe0c6';
const EMPTY_SET = new Set<string>();

// ---------------------------------------------------------------------------
// feat/stellar-camera-focus — density-aware layout helpers.
//
// PO repro: when the real graph holds only a handful of facts, nodes spread
// across the universe sphere as tiny dots and left-click rotation becomes a
// frustrating hunt-and-peck. The fix is density-aware tuning: when node
// count is small, pull nodes harder toward the centre, shorten link
// distances, and grow the node radius so each fact reads as a clearly
// targetable disc. As node count rises, the tuning ramps back toward the
// dense-galaxy defaults already set for synthetic mode.
//
// All three helpers are pure functions of `totalNodes`; the engine-ready
// hook below feeds the live d3-force instances from these. Pure-function
// shape was chosen so vitest can exercise the layout policy without ever
// mounting three.js (jsdom can't render WebGL).
// ---------------------------------------------------------------------------

/** Charge (n-body repulsion) strength for the d3-force `charge` simulation.
 *
 *  Convention: more negative ⇒ stronger repulsion ⇒ nodes spread further.
 *  Less negative ⇒ weaker repulsion ⇒ nodes huddle closer.
 *
 *  Small graphs (n<30) get -50 — weak repulsion so the few facts cluster
 *  around the centre instead of drifting to the universe sphere. Dense
 *  graphs (n≥120) keep the established -150 so cluster centroids stay
 *  legibly apart. A smooth log-ish ramp connects the two regimes. */
export function computeChargeStrength(totalNodes: number): number {
  const n = Math.max(0, totalNodes | 0);
  if (n < 30) return -50;
  if (n >= 120) return -150;
  // Linear ramp between -50 (n=30) and -150 (n=120).
  const t = (n - 30) / 90;
  return Math.round(-50 - 100 * t);
}

/** Link distance for the d3-force `link` simulation. Smaller → connected
 *  nodes sit physically closer, which compounds with the weaker charge
 *  above to pull the whole layout into a tighter ball when there are few
 *  facts. */
export function computeLinkDistance(totalNodes: number): number {
  const n = Math.max(0, totalNodes | 0);
  if (n < 30) return 12;
  if (n >= 120) return 18;
  const t = (n - 30) / 90;
  return Math.round(12 + 6 * t);
}

/** Center force strength — pulls every node toward the scene origin.
 *
 *  d3-force's `center` force does not normally take a strength scalar
 *  (it just re-centres the centroid each tick). ForceGraph3D exposes a
 *  `.strength(x)` setter on its center force as a convenience so callers
 *  can lean on it for "huddle the nodes" effects without writing a
 *  custom force. For small graphs we apply a noticeable inward tug; for
 *  large graphs we leave it at 0 so cluster structure dominates. */
export function computeCenterStrength(totalNodes: number): number {
  const n = Math.max(0, totalNodes | 0);
  if (n < 30) return 0.08;
  if (n >= 60) return 0;
  // Soft taper from 0.08 (n=30) to 0 (n=60).
  const t = (n - 30) / 30;
  return Number((0.08 * (1 - t)).toFixed(3));
}

/** Per-node base radius (before focus/selected/highlighted scaling).
 *
 *  This is the "how big is a fact, given the graph holds N facts" floor
 *  used by `nodeSize`. Small graphs win a bigger floor so each disc is
 *  trivially clickable. Larger graphs taper toward the dense-mode floor
 *  of 2.0 (kept from B-62-search-legibility). Formula: inverse-sqrt of
 *  n/10, clamped to [2.0, 5.0]. Reference points:
 *      n=1   → 5.0       n=10  → 5.0       n=30  → 3.65
 *      n=60  → 2.58      n=100 → 2.0       n=300 → 2.0
 */
export function computeNodeSizeFloor(totalNodes: number): number {
  const n = Math.max(1, totalNodes | 0);
  const raw = 5.0 / Math.sqrt(Math.max(1, n / 10));
  return Math.max(2.0, Math.min(5.0, Number(raw.toFixed(3))));
}

/** Camera initial distance from the origin.
 *
 *  Previously a smooth ramp from 180 (cold start) → 900 (full synthetic
 *  galaxy). The 180 floor was set when small graphs scattered across the
 *  universe sphere; now that they huddle toward the centre we can sit
 *  closer (130) so the first frame doesn't read as "tiny dots far away". */
export function computeInitialCameraDistance(totalNodes: number): number {
  const n = Math.max(0, totalNodes | 0);
  return Math.round(Math.max(130, Math.min(900, 30 + 18 * Math.sqrt(n))));
}

// ---------------------------------------------------------------------------
// feat/stellar-zoom-sync — unified zoom contract.
//
// PO repro: wheel and +/- controller showed mismatching values; wheel could
// reach 100x+ in the readout while the camera was visually stuck, +/- capped
// at 4.00x but the visual delta was small. Root cause: two competing paths
// (OrbitControls' built-in wheel dolly + applyZoom for buttons) wrote to two
// different effective states.
//
// Fix: ZOOM_MIN / ZOOM_MAX are the single absolute clamp for the displayed
// scale. Both wheel handling and +/- buttons funnel through `applyZoom`,
// which calls `clampZoom` before committing. The OrbitControls built-in
// wheel dolly is disabled (see handleEngineReady → controls.enableZoom =
// false) so it cannot race against the unified path.
//
// Value choice:
//   ZOOM_MIN 0.25 — same lower bound as the previous +/- button clamp;
//                   farthest zoom-out. At default 130-distance scene
//                   that means camera sits at distance 520 (well inside
//                   the 4500-radius starfield sphere).
//   ZOOM_MAX 4    — same upper bound as the previous +/- button clamp;
//                   closest zoom-in. At default 130-distance scene that
//                   means camera sits at distance 32.5 (above the
//                   computeInitialCameraDistance floor of 130's old
//                   "too close" zone, but inside cluster).
// ---------------------------------------------------------------------------
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

/** Clamp a zoom scalar to the unified [ZOOM_MIN, ZOOM_MAX] range. Exported so
 *  the vitest suite can pin the contract without re-deriving the constants. */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
}

/** Derive the displayed "Nx" string for a given zoom scalar. Single formula
 *  used by both wheel and +/- paths so the readout cannot diverge from the
 *  underlying camera distance. */
export function formatZoomLabel(z: number): string {
  return `${clampZoom(z).toFixed(2)}x`;
}

export interface StellarGraphProps {
  /** Graph payload. Updating swaps the canvas data; the camera is preserved. */
  data: StellarGraphData;
  /** Synthetic mode draws typed-color edges; real mode uses a single accent. */
  mode: 'synthetic' | 'real';
  /** Hover callback (node or null). */
  onNodeHover?: (node: StellarNode | null) => void;
  /** Click callback (full node). */
  onNodeClick?: (node: StellarNode) => void;
  /** B-62-v1 — id of the currently focused node (set by parent on click).
   *  When non-null, distant nodes dim and only focus-incident edges keep
   *  their typed colour. */
  focusedId?: string | null;
  /** B-62-v1 — set of node ids that are 1-hop from `focusedId`, PLUS any
   *  ids the user added via the focus-panel 펼치기 action. The parent
   *  unions these into one set. */
  focusedNeighborIds?: Set<string>;
  /** B-62-focus-select-actions — id of the currently selected sub-node
   *  inside the focus subgraph (clicked from the relations list). Acts
   *  as a third visual tier between highlighted and focused — selected
   *  sits clearly above highlighted but does NOT re-centre the camera.
   *  When equal to focusedId, the tier collapses to "focused". */
  selectedId?: string | null;
  /** B-62-clear-focus-home-lookat — incremented by the parent on every
   *  explicit "go back to overview" trigger (focus panel × close,
   *  Escape, source toggle). Acts as an effect-trigger token: when
   *  the value rises, the renderer eases the camera's lookAt target
   *  back to the scene origin while preserving the user's current
   *  eye position and orbit/zoom. The home view's 균형 잡힌 중심점
   *  is restored without yanking the user's framing. */
  viewResetTick?: number;
}

// B-62-v1 — colour helpers used by the renderer hooks.
//
// `lift` multiplies each channel by `factor` (clamped). Used to lift a base
// cluster colour by the node's validation strength: a 1.0× pixel sits at the
// palette colour; a >1× pixel pushes past it (and past the bloom threshold)
// so well-validated facts visibly glow.
//
// `mixToDim` blends toward a near-background neutral so out-of-focus nodes
// fade without disappearing — the spec says "흐리게", not "invisible".
function lift(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const out = (x: number) => Math.round(clamp(x) * 255).toString(16).padStart(2, '0');
  return `#${out(r * factor)}${out(g * factor)}${out(b * factor)}`;
}
function mixToDim(hex: string, retainedSaturation: number): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  // Background-leaning neutral with a teal hint so dim nodes still read as
  // "knowledge graph" rather than dead grey.
  const bgR = 0.08;
  const bgG = 0.12;
  const bgB = 0.13;
  const k = retainedSaturation;
  const nr = r * k + bgR * (1 - k);
  const ng = g * k + bgG * (1 - k);
  const nb = b * k + bgB * (1 - k);
  const out = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${out(nr)}${out(ng)}${out(nb)}`;
}

// B-62-focus-select-fix-edges-highlight — blend toward white for the
// selected / focused tiers. The `lift()` helper above is capped at the
// 0.95 emissive ceiling, so for already-bright nodes (well-validated,
// factor at the cap) the tier deltas of +0.05 / +0.10 were a no-op —
// PO repro: selected node didn't visibly highlight on the canvas.
// blendToWhite layers a white mix on top of the lifted base WITHOUT
// touching the underlying lift cap; the result reads as visibly
// brighter regardless of the base validation strength.
//   t = 0 → return hex unchanged
//   t = 1 → return pure white
function blendToWhite(hex: string, t: number): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const blend = (x: number) => x + (1 - x) * t;
  const out = (x: number) =>
    Math.round(Math.max(0, Math.min(1, x)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${out(blend(r))}${out(blend(g))}${out(blend(b))}`;
}

interface ForceGraphRefHandle {
  postProcessingComposer?: () => { addPass: (pass: unknown) => void } | undefined;
  scene?: () => THREE.Scene;
  camera?: () => THREE.PerspectiveCamera;
  controls?: () => {
    autoRotate?: boolean;
    autoRotateSpeed?: number;
    enableDamping?: boolean;
    dampingFactor?: number;
    // feat/stellar-zoom-sync — OrbitControls' built-in mouse-wheel dolly.
    // Must be disabled so our unified wheel handler (in StellarGraph) is
    // the single writer of camera distance. With both enabled the two
    // paths race and the displayed zoom drifts away from the actual
    // camera distance — PO repro: wheel reads 100x while camera frozen.
    enableZoom?: boolean;
  };
  // B-62-fix2 — added for bloom-accumulation defeat. We need the renderer
  // to wipe UnrealBloomPass's ping-pong targets every frame.
  renderer?: () => THREE.WebGLRenderer;
  cameraPosition?: (
    pos: { x: number; y: number; z: number },
    lookAt?: { x: number; y: number; z: number } | null,
    duration?: number,
  ) => void;
}

// B-62-fix2 — UnrealBloomPass exposes the ping-pong target arrays we need
// to clear each frame. Three's typings don't expose these on the base
// Pass class, so we narrow with our own structural type.
interface BloomTargets {
  renderTargetsHorizontal?: THREE.WebGLRenderTarget[];
  renderTargetsVertical?: THREE.WebGLRenderTarget[];
}

// B-62-fix3 — EffectComposer exposes its primary ping-pong pair as
// renderTarget1 / renderTarget2. Clearing these is a secondary defense
// against bloom accumulation if the bloom pass's own targets stay stuck.
interface ComposerTargets {
  renderTarget1?: THREE.WebGLRenderTarget;
  renderTarget2?: THREE.WebGLRenderTarget;
  addPass: (pass: unknown) => void;
}

/** Add a slow-rotating starfield behind the graph. The dots are tiny so the
 *  bloom pass doesn't bleed them; the rotation gives the "우주감" without
 *  flooding the eye. */
function attachStarfield(scene: THREE.Scene): THREE.Points {
  // B-62-demo-clusters-edges — density bumped 4000 → 9000 so the
  // background reads as a 풍부 cosmic backdrop. Per-star material
  // (color 0x3a4858 × opacity 0.4 ≈ 0.108 effective brightness) is
  // still under the bloom threshold 0.55, so raising the count does
  // NOT bloom-bleed — the "노드만 글로우" principle holds.
  const count = 9000;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  // Place each point on a large sphere (radius 4500) — far behind the
  // graph (which sits inside ~600 unit cube), so it never occludes nodes.
  const RADIUS = 4500;
  for (let i = 0; i < count; i += 1) {
    // Uniform on a sphere: pick u ∈ [-1,1], θ ∈ [0,2π).
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * 2 * Math.PI;
    const r = Math.sqrt(1 - u * u);
    positions[i * 3 + 0] = Math.cos(theta) * r * RADIUS;
    positions[i * 3 + 1] = u * RADIUS;
    positions[i * 3 + 2] = Math.sin(theta) * r * RADIUS;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  // B-62-cosmic-tune — starfield re-tuned for "확실한 배경 역할".
  // PO directive: stars should read as a crisp static texture, NOT
  // dissolve into fog when bloom strength rises (we just bumped to
  // 0.5). Recipe:
  //   color   0x2a3540 → 0x3a4858 (luminance 0.18 → 0.27 — visibly
  //           "또렷한" against the #06080b background).
  //   opacity 0.25 → 0.40           (more presence per pixel).
  //   size    0.6 unchanged.
  // Effective brightness ≈ 0.27 × 0.40 = 0.108, still well under the
  // bloom threshold (0.55), so the stars stay as points and do NOT
  // bloom-bleed into surrounding haze. (per PO acceptance ② — "또렷한
  // 정적 배경, bloom 으로 안 번짐".)
  const material = new THREE.PointsMaterial({
    color: 0x3a4858,
    size: 0.6,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
  });
  const stars = new THREE.Points(geometry, material);
  stars.name = 'lucid-stellar-starfield';
  scene.add(stars);
  return stars;
}

/** B-62-synthetic-galaxy-starfield — bright accent stars for synthetic.
 *
 * A second, sparser Points layer that shows ONLY in synthetic mode.
 * Bigger and slightly brighter than the main field, giving the galaxy
 * the "some stars stand out" texture you see on a night sky photo.
 * Still tuned well under the bloom threshold (color luminance ~0.43 ×
 * opacity 0.55 ≈ 0.24, threshold 0.55) so the accent layer stays as
 * crisp points and does NOT bloom-bleed.
 */
function attachAccentStarfield(scene: THREE.Scene): THREE.Points {
  const count = 350;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  // Accent layer sits a touch closer than the main field so the depth
  // separation reads correctly even though both layers ignore depth.
  const RADIUS = 4100;
  for (let i = 0; i < count; i += 1) {
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * 2 * Math.PI;
    const r = Math.sqrt(1 - u * u);
    positions[i * 3 + 0] = Math.cos(theta) * r * RADIUS;
    positions[i * 3 + 1] = u * RADIUS;
    positions[i * 3 + 2] = Math.sin(theta) * r * RADIUS;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0x8aa0bc,  // pale blue-white, luminance ~0.43
    size: 1.4,
    sizeAttenuation: true,
    transparent: true,
    // B-62-starfield-presence-plus10 — PO: "+10% 존재감".
    // 0.55 → 0.605. Effective brightness 0.43 × 0.605 ≈ 0.26, still
    // well under the bloom threshold (0.55) so the accent layer stays
    // crisp points and does NOT bloom-bleed.
    opacity: 0.605,
    depthWrite: false,
  });
  const stars = new THREE.Points(geometry, material);
  stars.name = 'lucid-stellar-accent-stars';
  stars.visible = false; // toggled on per mode in the useEffect below
  scene.add(stars);
  return stars;
}

export function StellarGraph(props: StellarGraphProps) {
  const {
    data,
    mode,
    onNodeHover,
    onNodeClick,
    focusedId = null,
    focusedNeighborIds,
    selectedId = null,
    viewResetTick = 0,
  } = props;
  // Stable identity for the "no focus" case so the callback memo deps don't
  // churn when the parent hasn't sent a set yet.
  const neighborSet = focusedNeighborIds ?? EMPTY_SET;
  const fgRef = useRef<ForceGraphRefHandle | null>(null);
  const starsRef = useRef<THREE.Points | null>(null);
  // B-62-synthetic-galaxy-starfield — accent layer for the brighter
  // "stand-out" stars in synthetic mode. Held in its own ref so the
  // mode useEffect can hide it without touching the main field.
  const accentStarsRef = useRef<THREE.Points | null>(null);
  // B-62-fix2/fix3 — references held so the per-frame tick can clear
  // both the bloom pass's ping-pong buffers AND the EffectComposer's
  // primary ping-pong pair (defeats brightness accumulation that made
  // nodes "appear to grow" and the starfield bleed into noise).
  const bloomRef = useRef<(UnrealBloomPass & BloomTargets) | null>(null);
  const composerRef = useRef<ComposerTargets | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);
  // B-62-fix4 — zoom controller state. 1.0 = initial camera distance
  // (900 in scene units). >1 = closer, <1 = farther. Clamped to [0.25, 4]
  // so the user can't dolly past the cluster or out into the starfield.
  const [zoom, setZoom] = useState(1.0);
  // B-62-search-legibility — INITIAL_DIST is now data-aware. A 65-node
  // real graph at fixed 900 looked like a dust speck. Smooth ramp from
  // 180 (cold start) up to 900 (full 3k synthetic galaxy) so the camera
  // auto-fits to whatever's there. Held in a ref so the zoom-poll +
  // applyZoom paths see the latest value without forcing re-renders.
  const initialDistRef = useRef(900);
  // feat/stellar-camera-focus — node-count ref. Read by `handleEngineReady`
  // (single-shot at first attach) so the d3-force tuning and the initial
  // camera distance both react to the current graph size without making
  // handleEngineReady depend on `data` (which would defeat the single-shot
  // guard and reset the camera on every data update).
  const nodeCountRef = useRef(data.nodes.length);
  // Derive the dist once per data swap and stash in the ref. The
  // handleEngineReady single-shot guard means this only affects the
  // camera at first mount; subsequent toggles/refetches update the
  // zoom-readout reference frame but do not snap the camera.
  useEffect(() => {
    // feat/stellar-camera-focus — floor lowered 180 → 130 (small graphs
    // sit closer now that they huddle inward; see computeInitialCameraDistance).
    nodeCountRef.current = data.nodes.length;
    initialDistRef.current = computeInitialCameraDistance(data.nodes.length);
  }, [data]);
  // B-62-fix-zoom-reset — single-shot guard for handleEngineReady. PO
  // repro: wheel zoom snapped back to ~1.0× within ~150ms. Root cause:
  // the ForceGraph3D `ref` was an INLINE arrow, so React re-evaluated
  // it every render. Every time the wheel-poll `setInterval` below
  // committed a new `zoom` value (which happens whenever the user
  // dollies), React detached the old ref (fgRef ← null) and attached
  // the new one (fgRef ← node, then `if (node) handleEngineReady()`).
  // That re-invocation contained `cameraPosition({z:900})` and reset
  // the camera, erasing the user's dolly. The guard makes the engine-
  // ready setup truly idempotent — it runs once per mount.
  const initializedRef = useRef(false);

  // B-62-fix5 — explicit hover-scale state. Without this the only hover
  // B-62-v1-fix1 — hoveredId state was removed because keeping it caused
  // the nodeSize callback's deps to churn every hover (see nodeSize
  // comment further down). The hover visual now lives only in the parent
  // tooltip; the renderer is hover-agnostic. The parent still gets the
  // hover signal through onNodeHover.

  // Observe container size so the canvas fills the parent fullscreen layout.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const ro = new ResizeObserver(() => {
      const rect = node.getBoundingClientRect();
      setSize({ w: rect.width, h: rect.height });
    });
    ro.observe(node);
    const rect = node.getBoundingClientRect();
    setSize({ w: rect.width, h: rect.height });
    return () => ro.disconnect();
  }, []);

  // One-time scene wiring: bloom pass + starfield + camera config.
  // B-62-fix-zoom-reset — early-return when already initialised so
  // subsequent ref re-attaches (caused by ANY React re-render under
  // the inline ref callback pattern below) do NOT reset the camera or
  // double-add the bloom pass.
  const handleEngineReady = useCallback(() => {
    const handle = fgRef.current;
    if (!handle) return;
    if (initializedRef.current) return;
    initializedRef.current = true;

    // B-62-fix2 — bloom tuning + reference capture.
    //
    // Previous (fix1): strength 1.7, radius 0.55, threshold 0.15. PO
    // dogfood found nodes apparently growing over time and starfield
    // glowing as noise. Root cause (PO's hypothesis, confirmed by the
    // tick-loop clear below): UnrealBloomPass's internal ping-pong
    // render targets were not being cleared each frame, so each frame's
    // bloom contribution layered on top of the previous one — perceived
    // as steady brightness inflation across the whole canvas.
    //
    // Tuning:
    //   strength  1.7 → 1.2  — still glows the teal/cyan/mint nodes
    //                          (luminance ~0.7) but stops the canvas-
    //                          wide halo wash.
    //   radius    0.55 → 0.5 — slightly tighter spread.
    //   threshold 0.15 → 0.4 — pixels below luminance 0.4 are exempt
    //                          from bloom entirely. The dimmed starfield
    //                          (color 0x506070 ≈ luminance 0.36 × opacity
    //                          0.4) sits comfortably below the line, so
    //                          stars are now points, not torches.
    // B-62-fix3 — bloom dramatically softened + composer reference.
    //
    // fix2 set strength 1.2, threshold 0.4. PO repro: SYNTHETIC (2000
    // nodes) was immediate whiteout; REAL (5 nodes) was bearable. The
    // density-dependent failure confirms the bloom contribution per
    // pixel was still too high — and we couldn't rely on the per-frame
    // bloom-target clear because the ForceGraphRefHandle from
    // react-force-graph-3d does NOT expose `.renderer()`, so the clear
    // loop was a silent no-op. fix3 attacks the magnitude instead:
    //   strength  1.2 → 0.6  — half. Nodes still glow but a single frame
    //                          of bloom contribution is sub-perceptible
    //                          on dense clusters.
    //   radius    0.5 → 0.4  — tighter halo, less spread into adjacent
    //                          pixels.
    //   threshold 0.4 → 0.6  — pixels below luminance 0.6 are exempt,
    //                          which now includes mid-tone teal pixels;
    //                          only the brightest peaks bloom.
    //
    // We also capture the composer reference itself so the tick can
    // clear composer.renderTarget1/2 (these DO live on the composer
    // object) — that's the secondary line of defense if the bloom
    // ping-pong targets stay stuck for any reason.
    // B-62-fix4 — bloom balance: stars sharp, not blurry blobs.
    // fix3 dropped strength to 0.6 / radius 0.4 / threshold 0.6 to defeat
    // whiteout. PO acceptance: stars now visible but they read as fuzzy
    // halos rather than sharp points. Raise strength slightly (0.6 → 0.8
    // matches PO's "~0.8" target) and crush the radius (0.4 → 0.25) so
    // bloom contributes a tight glow around each node instead of a wide
    // blur. Threshold relaxed 0.6 → 0.55 to keep mid-tone teal nodes
    // genuinely bright, not anaemic.
    // B-62-v1 — bloom balanced for "검증된 팩트일수록 빛난다".
    // strength 0.4 sits between fix4's 0.8 (too bright) and fix5's 0.1
    // (too dark). Combined with the `lift()` colour multiplier in
    // `nodeColor`, well-validated facts (validationStrength → 1) push
    // their pixel luminance over threshold 0.5 and bloom; weakly
    // validated facts (vs ~0.35) sit at base palette luminance and stay
    // as sharp points. radius 0.25 keeps the halo tight.
    // B-62-fix-glow-clamp — bloom strength further reduced (0.4 → 0.3)
    // and threshold raised (0.5 → 0.55). PO repro on v1: dense core
    // nodes escalated to pure white during camera moves. With the
    // ACESFilmic tone-mapping added on the renderer below, any residual
    // bloom contribution rolls off softly instead of clipping — so the
    // peaks stay identifiable even under accumulation pressure.
    const composer = handle.postProcessingComposer?.();
    if (composer && typeof composer.addPass === 'function') {
      // B-62-cosmic-tune — strength 0.3 → 0.5. PO directive: nodes
      // should glow more visibly now that ACESFilmic tone mapping +
      // emissive cap + once-only bloom add are in place to prevent
      // whiteout. Threshold 0.55 / radius 0.25 unchanged so the bloom
      // still picks ONLY the high-luminance peaks (well-validated
      // facts), not the dim background or the mid-tone clusters.
      const bloom = new UnrealBloomPass(new THREE.Vector2(1024, 1024), 0.5, 0.25, 0.55);
      composer.addPass(bloom);
      bloomRef.current = bloom as UnrealBloomPass & BloomTargets;
      composerRef.current = composer as unknown as ComposerTargets;
    }
    // Renderer setup — autoClear (existing), pixelRatio (existing), and
    // ACESFilmic tone mapping (NEW in fix-glow-clamp).
    const renderer = handle.renderer?.();
    if (renderer) {
      renderer.autoClear = true;
      renderer.autoClearColor = true;
      renderer.autoClearDepth = true;
      // B-62-fix4 — honour the device pixel ratio so high-DPI displays
      // render the canvas at native resolution. The default ratio (1)
      // makes individual node pixels visibly soft on retina/4K panels.
      // Cap at 2 so we don't pay for 3× supersampling on phones.
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
      renderer.setPixelRatio(Math.min(dpr, 2));
      // B-62-fix-glow-clamp — ACESFilmic tone mapping. This is the load-
      // bearing fix for PO's "흰색 포화" complaint. Without tone mapping
      // every fragment > 1 in any channel clamps to 1 and we lose detail
      // forever; with ACESFilmic, the curve rolls off so brightness
      // peaks compress into the high-mid range, preserving local
      // contrast even at peak bloom. Exposure 1.0 = neutral; we tune
      // brightness via bloom strength and the lift cap, not exposure.
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;
      rendererRef.current = renderer;
    }

    // Dark cosmic background + starfield.
    //
    // B-62-fix1 — the ForceGraph3D `backgroundColor` prop is set, but with
    // UnrealBloomPass mounted on the composer the clear color reverts to
    // white at the first frame (the bloom pass's intermediate buffer was
    // running over the renderer's clear). A non-zero clear that high
    // (1,1,1 ≫ threshold 0.15) made the bloom flare the entire canvas to
    // whiteout. Setting `scene.background` directly bypasses the prop path
    // and forces the dark colour onto the scene the bloom pass actually
    // sees — verified by PO (white screen → galaxy on dark canvas).
    const scene = handle.scene?.();
    if (scene) {
      scene.background = new THREE.Color(0x06080b);
      if (!starsRef.current) {
        starsRef.current = attachStarfield(scene);
      }
      // B-62-synthetic-galaxy-starfield — accent layer mounted at
      // engine-ready; visibility is then driven by the mode useEffect
      // below so it only appears in synthetic.
      if (!accentStarsRef.current) {
        accentStarsRef.current = attachAccentStarfield(scene);
      }
    }

    // Camera + controls: narrow FOV, autoRotate slow, damping on.
    const camera = handle.camera?.();
    if (camera) {
      camera.fov = 45;
      camera.updateProjectionMatrix();
    }
    const controls = handle.controls?.();
    if (controls) {
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.25; // ~0.3 deg/s feel
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      // feat/stellar-zoom-sync — disable OrbitControls' built-in mouse-wheel
      // dolly so the StellarGraph-level wheel handler is the SINGLE writer
      // of camera distance. Without this the OrbitControls dolly and our
      // unified applyZoom race; PO repro showed wheel readout climbing past
      // 100x while the camera was visually frozen (OrbitControls' internal
      // min/max collided with our display formula). Buttons + wheel now
      // both funnel through applyZoom → clampZoom, single source of truth.
      controls.enableZoom = false;
    }

    // B-62-demo-clusters-edges + feat/stellar-camera-focus — d3-force tune
    // is now density-aware (see compute* helpers at module top).
    //
    // Dense graphs (≥120 nodes) keep the B-62 defaults: charge -150 and
    // link distance 18, which let cluster centroids spread visibly on the
    // synthetic galaxy. Small graphs (<30 nodes, the PO repro) get
    // charge -50, link distance 12, AND a gentle inward `center` force —
    // those three knobs together huddle the few facts toward the origin
    // so left-click rotation has something to grab onto instead of dust
    // scattered across the universe sphere.
    type ForceLike = {
      strength?: (s: number) => unknown;
      distance?: (d: number) => unknown;
    };
    type ForceGraphForcedExt = {
      d3Force?: (name: string) => ForceLike | undefined;
    };
    const inst = handle as unknown as ForceGraphForcedExt;
    // Read via the ref so this stays a stable, prop-independent callback
    // (the single-shot guard must run with zero `data` deps).
    const totalNodes = nodeCountRef.current;
    inst.d3Force?.('charge')?.strength?.(computeChargeStrength(totalNodes));
    inst.d3Force?.('link')?.distance?.(computeLinkDistance(totalNodes));
    const centerStrength = computeCenterStrength(totalNodes);
    if (centerStrength > 0) {
      // ForceGraph3D mounts a `center` force at the origin by default;
      // its `.strength(x)` setter is exposed so callers can drive an
      // explicit inward tug. No-op on engines that don't expose it.
      inst.d3Force?.('center')?.strength?.(centerStrength);
    }

    // B-62-search-legibility — pull-back uses data-aware initial dist
    // so a 65-node real graph doesn't open as dust at z=900.
    handle.cameraPosition?.(
      { x: 0, y: 0, z: initialDistRef.current },
      { x: 0, y: 0, z: 0 },
      0,
    );
  }, []);

  // Per-frame tick. Two duties:
  //   (a) drift the starfield (very slow y-rotation),
  //   (b) B-62-fix2: clear UnrealBloomPass's ping-pong render targets so
  //       each frame's bloom doesn't accumulate on top of the previous
  //       one — without this the canvas brightness drifts upward forever
  //       (PO repro: nodes "growing", starfield turning into a glowing
  //       noise floor). UnrealBloomPass renders its blur into two pairs
  //       of ping-pong targets per mip level; clearing them at frame
  //       start forces the pass to start from black every time.
  useEffect(() => {
    let cancelled = false;
    function tick() {
      // B-62-cosmic-tune — starfield is now a STATIC background.
      // PO directive: "twinkle/반짝임 애니메이션 완전 제거 — 별의
      // 크기·투명도 per-frame 변동 없애고 고정값". The previous slow
      // y-rotation has been removed; the points sit on a fixed sphere
      // and never move. Combined with the brighter material above
      // this reads as "a confident background texture" rather than
      // "ambient particles".

      // Clear every render target that could be holding stale bloom:
      //   1. UnrealBloomPass's per-mip ping-pong pairs (renderTargets-
      //      Horizontal / Vertical),
      //   2. EffectComposer's primary pair (renderTarget1 / renderTarget2)
      //      — this is the fix3 secondary defense.
      // If the ref API doesn't expose .renderer() on this build of
      // react-force-graph-3d, rendererRef.current stays null and this
      // block is a no-op (the magnitude reductions in handleEngineReady
      // are the load-bearing fix in that case).
      const renderer = rendererRef.current;
      const bloom = bloomRef.current;
      const composer = composerRef.current;
      if (renderer && (bloom || composer)) {
        const prevTarget = renderer.getRenderTarget();
        if (bloom) {
          for (const t of bloom.renderTargetsHorizontal ?? []) {
            renderer.setRenderTarget(t);
            renderer.clear(true, true, true);
          }
          for (const t of bloom.renderTargetsVertical ?? []) {
            renderer.setRenderTarget(t);
            renderer.clear(true, true, true);
          }
        }
        if (composer) {
          if (composer.renderTarget1) {
            renderer.setRenderTarget(composer.renderTarget1);
            renderer.clear(true, true, true);
          }
          if (composer.renderTarget2) {
            renderer.setRenderTarget(composer.renderTarget2);
            renderer.clear(true, true, true);
          }
        }
        renderer.setRenderTarget(prevTarget);
      }

      if (!cancelled) requestAnimationFrame(tick);
    }
    const handle = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
    };
  }, []);

  // B-62-fix4 — starfield visibility tracks mode.
  // PO directive: REAL mode must NOT use the synthetic starfield as
  // B-62-cosmic-tune — starfield is now visible in BOTH modes. fix4
  // hid it on REAL to avoid the "fake galaxy" reading when only 5
  // facts existed; now that B-62-real-all-facts surfaces every fact
  // AND the starfield itself is a static, dim background texture
  // (no rotation, no twinkle, well below the bloom threshold), the
  // PO directive is to show stars in both modes as a "확실한 배경
  // 역할". Identity of synthetic vs real is carried by the data
  // (node count, cluster colour palette), not by the background.
  // B-62-synthetic-galaxy-starfield — mode-aware starfield brightness.
  // PO directive: "배경 starfield 가 synthetic 에서는 더 선명하게 보이길
  // 원한다. 갤럭시 느낌을 완성해야 한다." Real mode keeps the subtle
  // texture (KS data should dominate); synthetic gets a brighter main
  // layer + a sparse accent layer for the "stand-out stars" feel.
  //
  // All four tuned values stay under the bloom threshold (0.55):
  //   synthetic main:   color 0x5e7488 (lum 0.42) × opacity 0.7 ≈ 0.30
  //   synthetic accent: color 0x8aa0bc (lum 0.43) × opacity 0.55 ≈ 0.24
  //   real main:        color 0x3a4858 (lum 0.27) × opacity 0.40 ≈ 0.11
  //   real accent:      hidden
  // The "노드만 글로우" principle holds — only the validated nodes
  // bloom; the starfield, even at synthetic brightness, stays as
  // crisp points.
  useEffect(() => {
    const stars = starsRef.current;
    const accent = accentStarsRef.current;
    if (stars) {
      stars.visible = true;
      const mat = stars.material as THREE.PointsMaterial;
      if (mode === 'synthetic') {
        mat.color.setHex(0x5e7488);
        // B-62-starfield-presence-plus10 — PO: "+10% 존재감".
        // 0.7 → 0.77. Effective brightness 0.42 × 0.77 ≈ 0.32, still
        // safely under the bloom threshold (0.55).
        mat.opacity = 0.77;
        mat.size = 0.85;
      } else {
        mat.color.setHex(0x3a4858);
        mat.opacity = 0.4;
        mat.size = 0.6;
      }
      mat.needsUpdate = true;
    }
    if (accent) {
      accent.visible = mode === 'synthetic';
    }
  }, [mode]);

  // feat/stellar-zoom-sync — wheel handler is now the single explicit writer
  // of camera distance for mouse-wheel zoom. OrbitControls' built-in dolly
  // is disabled in handleEngineReady (enableZoom=false), so this listener
  // owns the wheel UX end-to-end:
  //
  //   1. preventDefault so the page doesn't scroll behind the canvas.
  //   2. Compute a step factor from deltaY (1.1× per notch matches the
  //      tactile feel of the +/- buttons' 1.25× / 0.8× steps roughly).
  //   3. Funnel through `applyZoom`, which clampZoom's and writes both
  //      the `zoom` state (drives the +/− readout) AND the actual camera
  //      position. The +/− buttons call the SAME function, guaranteeing
  //      readout consistency.
  //
  // Bound to the container ref (not window) so wheel events outside the
  // stellar canvas — e.g. scrolling the page header — keep their default
  // behaviour. `{ passive: false }` is required because we preventDefault.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // 1.1× per notch. Wheel down (positive deltaY) → zoom out → smaller
      // scale. Wheel up → zoom in → larger scale. Use the latest zoom via
      // the functional setter inside applyZoom so we don't capture stale
      // closure state across renders.
      const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
      applyZoomRef.current(zoomRef.current * factor);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  // B-62-search-legibility — fly camera to the focused node. Triggers
  // on focus changes from both click AND the new search bar. The
  // simulation may not have settled when this fires, in which case
  // node.x/y/z default to 0; we guard against the all-zero case so
  // the camera stays put rather than teleporting to the origin.
  useEffect(() => {
    if (!focusedId) return;
    const node = data.nodes.find((n) => n.id === focusedId) as
      | (StellarNode & { x?: number; y?: number; z?: number })
      | undefined;
    if (!node) return;
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const z = node.z ?? 0;
    if (x === 0 && y === 0 && z === 0) return;
    const handle = fgRef.current;
    if (!handle?.cameraPosition) return;
    // Pull back along the node's outward direction so the focal node
    // sits in the centre of the view with its 1-hop neighbours visible.
    // Use a distance scaled to the data so small graphs don't dolly too
    // far. 1.2× node-radius from origin gives a tight but workable frame.
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    const dollyOut = 90;
    const k = (len + dollyOut) / len;
    handle.cameraPosition(
      { x: x * k, y: y * k, z: z * k },
      { x, y, z },
      900,
    );
  }, [focusedId, data]);

  // B-62-focus-select-actions — selected node gets a *gentle* lookAt
  // ease, NOT a full re-centre. PO directive: "관계행 클릭 → 즉시 그
  // 노드로 자동 re-center" was disorienting; users lost their place.
  // Now: when selectedId changes (and is distinct from focusedId), we
  // keep the camera's eye position fixed and rotate the lookAt target
  // toward the selected node over 500ms. The visual brightness tier
  // does the heavy lifting; the camera just nudges. Use the existing
  // 중심으로 button to do a full re-centre.
  useEffect(() => {
    if (!selectedId) return;
    if (selectedId === focusedId) return; // collapsed tier, nothing to ease
    const node = data.nodes.find((n) => n.id === selectedId) as
      | (StellarNode & { x?: number; y?: number; z?: number })
      | undefined;
    if (!node) return;
    const tx = node.x ?? 0;
    const ty = node.y ?? 0;
    const tz = node.z ?? 0;
    if (tx === 0 && ty === 0 && tz === 0) return;
    const handle = fgRef.current;
    const camera = handle?.camera?.();
    if (!handle?.cameraPosition || !camera) return;
    handle.cameraPosition(
      { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      { x: tx, y: ty, z: tz },
      500,
    );
  }, [selectedId, focusedId, data]);

  // B-62-clear-focus-home-lookat — restore the home lookAt without
  // touching the eye position.
  //
  // PO repro: closing the focus panel left the camera looking AT the
  // last-focused node, so the next orbit/wheel spun around the wrong
  // pivot — the user's exploration centre was secretly gone. Now,
  // when the parent bumps `viewResetTick`, we ease the lookAt target
  // back to the scene origin (0,0,0) over 800ms WHILE keeping the
  // camera's eye position exactly where the user left it. Result: the
  // user's wheel-zoom and orbit-drag survive the reset; only the
  // 균형 잡힌 중심점 returns to the origin where the full graph sits.
  //
  // We skip the very first tick (0) so the initial mount doesn't
  // re-trigger the engine-ready camera setup.
  useEffect(() => {
    if (viewResetTick === 0) return;
    const handle = fgRef.current;
    const camera = handle?.camera?.();
    if (!handle?.cameraPosition || !camera) return;
    handle.cameraPosition(
      { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      { x: 0, y: 0, z: 0 },
      800,
    );
  }, [viewResetTick]);

  // feat/stellar-zoom-sync — imperative zoom step. Single source of truth
  // for BOTH wheel and +/- button paths. Reads the current camera direction
  // from the live ref so it composes correctly with autoRotate and user
  // orbit; only the distance along the eye→origin axis changes.
  //
  // The unified [ZOOM_MIN, ZOOM_MAX] clamp from the module-level constants
  // is applied here exactly once — wheel callers and button callers share
  // it. The displayed `zoom` state is set from the SAME clamped value, so
  // the readout cannot drift past the physical limits.
  //
  // Animation duration was 250ms when only buttons drove this; we keep that
  // for buttons but the wheel-handler will accept a 0 to make wheel feel
  // immediate. (The 250ms tween on buttons makes the stepwise zoom feel
  // deliberate; wheel wants tactile 1:1 response.)
  const applyZoom = useCallback((nextZoom: number, durationMs = 250) => {
    const clamped = clampZoom(nextZoom);
    setZoom(clamped);
    const handle = fgRef.current;
    const camera = handle?.camera?.();
    if (!camera || !handle?.cameraPosition) return;
    const dir = camera.position.clone();
    if (dir.lengthSq() === 0) dir.set(0, 0, 1);
    dir.normalize();
    const newDist = initialDistRef.current / clamped;
    const target = dir.multiplyScalar(newDist);
    handle.cameraPosition(
      { x: target.x, y: target.y, z: target.z },
      { x: 0, y: 0, z: 0 },
      durationMs,
    );
  }, []);

  // feat/stellar-zoom-sync — refs that mirror the latest `zoom` value and
  // the latest `applyZoom` callable so the wheel-handler effect (which
  // runs ONCE at mount, no deps) always sees the freshest closure. Without
  // these the wheel would multiply factor against the initial 1.0 forever
  // and applyZoom would be a stale closure. The +/- buttons read from
  // `zoom` state directly so they re-render with the live value.
  const zoomRef = useRef(1.0);
  const applyZoomRef = useRef(applyZoom);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    applyZoomRef.current = applyZoom;
  }, [applyZoom]);

  // B-62-v1 — link colour reflects edge TYPE (synthetic) or the single
  // accent (real). Focus mode adds a second layer: edges incident on the
  // focused node keep their typed colour; the rest fade to near-invisible
  // so the focal subgraph reads cleanly.
  const linkColor = useCallback(
    (link: StellarLink): string => {
      // B-62-demo-clusters-edges — corroboration modulates the alpha
      // channel in synthetic mode. score 0.05 → near-invisible
      // background filament, score 1.0 → bright constellation edge.
      // Real mode (no score) keeps the flat accent.
      let baseColor: string;
      if (mode === 'real') {
        baseColor = 'rgba(63,224,198,0.55)';
      } else {
        const typeColor = EDGE_COLORS[link.type] ?? '#ffffff';
        const score =
          typeof link.corroborationScore === 'number'
            ? Math.max(0.04, Math.min(1, link.corroborationScore))
            : 0.55;
        // Convert hex → rgb so we can attach the corroboration alpha.
        const r = parseInt(typeColor.slice(1, 3), 16);
        const g = parseInt(typeColor.slice(3, 5), 16);
        const b = parseInt(typeColor.slice(5, 7), 16);
        baseColor = `rgba(${r},${g},${b},${score.toFixed(3)})`;
      }
      if (focusedId === null) return baseColor;
      // ForceGraph3D mutates link.source/target to node objects after the
      // simulation runs. Handle both shapes.
      const src =
        typeof link.source === 'string'
          ? link.source
          : (link.source as { id?: string } | null)?.id ?? '';
      const tgt =
        typeof link.target === 'string'
          ? link.target
          : (link.target as { id?: string } | null)?.id ?? '';
      // B-62-focus-select-fix-edges-highlight — an edge is bright when
      // BOTH endpoints live in the highlight subgraph (focused +
      // selected + the union'd 1-hop / expanded ring). Previously the
      // rule was "src OR tgt === focusedId", which left edges between
      // 펼치기-ed nodes invisible — PO repro: "펼치기 하면 노드
      // 하이라이트는 되는데 연결된 edge 는 안 나타남."
      const inSubgraph = (id: string) =>
        id === focusedId ||
        id === selectedId ||
        neighborSet.has(id);
      const incident = inSubgraph(src) && inSubgraph(tgt);
      return incident ? baseColor : 'rgba(45,55,65,0.06)';
    },
    [mode, focusedId, selectedId, neighborSet],
  );

  // B-62-demo-clusters-edges — link width also scales with corroboration
  // (low score = thin filament, high score = chunky filament) so the
  // bright constellation pops on both colour AND geometry channels.
  const linkWidth = useCallback(
    (link: StellarLink): number => {
      if (mode === 'real') return 0.6;
      const score =
        typeof link.corroborationScore === 'number'
          ? Math.max(0, Math.min(1, link.corroborationScore))
          : 0.5;
      return 0.4 + score * 1.0;
    },
    [mode],
  );

  // B-62-v1 — node colour composes three signals:
  //   1. cluster palette (which subject group this fact belongs to).
  //   2. validation strength — the colour is multiplied by (0.6 + vs * 0.5)
  //      so well-validated facts push past the bloom threshold and glow,
  //      while thin facts stay as sharp but un-bloomed points.
  //   3. focus dim — when the user has focused a node, distant nodes
  //      blend toward the dark background so the 1-hop subgraph stands out.
  // B-62-fix-glow-clamp — emissive lift now CAPPED.
  // Previous (v1): `lift(base, 0.6 + vs * 0.5)` → max factor 1.1, which
  // pushed luminance peaks above 1.0 and clipped to white once the bloom
  // pass added on top. New formula: `min(0.95, 0.5 + vs * 0.35)` → max
  // factor 0.85 for a fully validated fact. The cluster colour stays the
  // dominant signal; the validation channel just brightens it modestly.
  // Combined with ACESFilmic tone mapping, no single pixel can saturate
  // to (1,1,1) — peaks roll off, peaks stay identifiable.
  const nodeColor = useCallback(
    (node: StellarNode): string => {
      const base =
        CLUSTER_PALETTE[(node.cluster ?? 0) % CLUSTER_PALETTE.length] ?? ACCENT;
      const vs = node.validationStrength ?? 0.5;
      // B-62-search-legibility — brightness floor 0.7. PO directive:
      // node luminance should sit clearly above the background-star
      // floor (~0.108) and close to the bloom threshold (0.55) so even
      // dim facts read as "validated star" not "noise". Min factor
      // 0.725 × teal-luminance 0.73 ≈ 0.53 (right at threshold for a
      // hint of glow). Max stays 0.95 to keep the ACES + emissive cap
      // safety net intact (PO: tone mapping, glow cap unchanged).
      const factor = Math.min(0.95, 0.7 + vs * 0.25);
      const lifted = lift(base, factor);
      if (focusedId === null) return lifted;
      // B-62-focus-select-fix-edges-highlight — tier deltas now use
      // `blendToWhite` instead of an additive `lift` factor.
      //
      // Why: PO repro — selected node didn't visibly highlight on the
      // canvas. For well-validated nodes the base lift factor is
      // already at the 0.95 cap, so `factor + 0.05` and `factor + 0.10`
      // both collapse to 0.95 — no visible change. blendToWhite layers
      // a white mix on TOP of the lifted base, so the tiers separate
      // even at peak validation. The glow cap (0.95 lift) is still
      // applied to `lifted`, preserving the PO constraint that the
      // base emissive ceiling stays put.
      //   focused      → blendToWhite(lifted, 0.40)  — brightest peak
      //   selected     → blendToWhite(lifted, 0.22)  — clearly above
      //                                                 highlighted
      //   highlighted  → lifted                       — base palette
      //   distant      → mixToDim                     — dim
      if (focusedId === node.id) return blendToWhite(lifted, 0.4);
      if (selectedId !== null && selectedId === node.id) {
        return blendToWhite(lifted, 0.22);
      }
      if (neighborSet.has(node.id)) return lifted;
      return mixToDim(lifted, 0.18);
    },
    [focusedId, neighborSet, selectedId],
  );

  // B-62-v1-fix1 — node size derives from graph degree only. Hover scale
  // is REMOVED from this callback path.
  //
  // PO repro: hovering different nodes made the entire canvas "zoom in"
  // continuously. Root cause: this callback's dep list included
  // `hoveredId`, so the function reference churned every hover. The
  // underlying react-force-graph-3d wrapper treats nodeVal as a stable
  // signal — when its reference changes, three.js re-feeds the d3-force
  // simulation. Each reheat re-spreads the cluster slightly outward
  // while the camera holds, producing the apparent zoom-in.
  //
  // The hover visual now lives entirely in the cursor tooltip (HoverTooltip
  // in StellarView), which matches the v1 spec "hover = 가벼운 미리보기".
  // Focus signals stay in the deps — focus changes are rare and
  // intentional (click only), so the reheat there is acceptable and
  // actually helps re-balance the focal subgraph.
  const totalNodes = data.nodes.length;
  const sizeFloor = computeNodeSizeFloor(totalNodes);
  const nodeSize = useCallback(
    (node: StellarNode): number => {
      const importance = node.degree ?? node.weight ?? 1;
      // B-62-search-legibility + feat/stellar-camera-focus — size floor
      // is now density-aware (see computeNodeSizeFloor). PO repro: with
      // only a handful of facts the discs were tiny against the starfield
      // and hard to click while orbiting. Small graphs win up to a 5.0
      // floor; once the count crosses ~100 the floor falls back to the
      // established 2.0 so a dense galaxy doesn't smother the layout.
      const base = Math.max(sizeFloor, 0.9 + Math.sqrt(importance));
      // B-62-focus-select-actions — size mirrors the brightness tiers:
      //   focused 1.6 > selected 1.4 > highlighted 1.25 > distant 1.0
      // Selected sits clearly above highlighted on the geometry channel
      // too, matching the colour-tier shift in nodeColor.
      let scale = 1;
      if (focusedId === node.id) scale = 1.6;
      else if (selectedId !== null && selectedId === node.id) scale = 1.4;
      else if (focusedId !== null && neighborSet.has(node.id)) scale = 1.25;
      return base * scale;
    },
    [focusedId, neighborSet, selectedId, sizeFloor],
  );

  // B-62-v1-fix1 — straight forward to the parent. We no longer hold a
  // local hover id; the renderer is hover-agnostic and only StellarView's
  // HoverTooltip reacts to onNodeHover events.
  const handleHoverInternal = onNodeHover ?? undefined;

  // Tooltip text — react-force-graph reads `nodeLabel` to render the default
  // hover hint. Our parent component overlays a richer tooltip on top.
  const labelOf = useCallback((node: StellarNode): string => node.label, []);

  // B-62-fix-zoom-reset — stable ref callback. Even with the
  // single-shot guard inside handleEngineReady, an inline arrow as
  // `ref={...}` makes React detach/attach the ref every render, which
  // briefly sets `fgRef.current = null`. That null window broke the
  // wheel-poll interval (it sees no camera for one tick) and triggered
  // visual flicker in the focus subgraph. Memoising the callback
  // eliminates the detach/attach churn entirely.
  const attachRef = useCallback(
    (node: unknown) => {
      fgRef.current = node as ForceGraphRefHandle | null;
      if (node) handleEngineReady();
    },
    [handleEngineReady],
  );

  // The component is too tall to be useful without an explicit height — fill parent.
  return (
    <div
      ref={containerRef}
      data-testid="stellar-graph-root"
      data-mode={mode}
      style={{
        position: 'absolute',
        inset: 0,
        background: '#000',
        overflow: 'hidden',
      }}
    >
      {size.w > 0 && size.h > 0 ? (
        <ForceGraph3D
          ref={attachRef}
          graphData={data}
          width={size.w}
          height={size.h}
          backgroundColor="#06080b"
          nodeId="id"
          nodeLabel={labelOf}
          nodeColor={nodeColor}
          nodeVal={nodeSize}
          /* B-62-fix3 — small reductions across the lighting surfaces
           * so SYNTHETIC density (2000 nodes) does not pile per-pixel
           * bloom contributions into whiteout: node opacity slightly
           * down from 0.95 → 0.88, link particles disabled (each
           * particle is a bright dot that bloom catches; killing them
           * removes an entire category of point lights). */
          nodeOpacity={0.88}
          nodeResolution={12}
          linkColor={linkColor}
          /* B-62-demo-clusters-edges — link width as a corroboration-
           * driven function (was a constant 0.6). Synthetic mode only;
           * real mode still gets the flat 0.6. */
          linkOpacity={mode === 'real' ? 0.4 : 0.5}
          linkWidth={linkWidth}
          linkDirectionalParticles={0}
          linkDirectionalParticleSpeed={0.004}
          linkDirectionalParticleWidth={1.1}
          enableNodeDrag={false}
          showNavInfo={false}
          onNodeHover={handleHoverInternal}
          onNodeClick={onNodeClick}
          /* B-62-fix2 — let the d3-force simulation settle after ~300
           * ticks so node positions stop drifting. PO repro showed nodes
           * appearing to slowly grow even after the bloom-accumulation
           * fix; the residual movement was the simulation continuing to
           * compress clusters indefinitely. The velocity decay raise
           * (0.4 default → 0.55) shortens the settle without changing
           * the equilibrium layout. */
          cooldownTicks={300}
          d3VelocityDecay={0.55}
        />
      ) : null}
      {/* B-62-fix4 — bottom-right zoom controller. Three rows: + / scale /
       *  −. Buttons step by 1.25× / 0.8× (factor matches camera dolly
       *  feel). Disabled at the clamp ends. Scale shown to 2 decimals. */}
      <div
        data-testid="stellar-zoom-controls"
        style={{
          /* B-62-v1-fix1 — viewport-fixed positioning (was absolute
           * inside the graph container). PO repro: still invisible
           * after fix5's z-index 1000 lift — the dynamic-imported
           * ForceGraph3D wrapper creates its own stacking context that
           * the parent's absolute child can't reliably escape. `fixed`
           * leaves the entire stacking-context graph and pins to the
           * viewport. z-index lifted further (1000 → 10000) so even
           * AppShell ribbons and any modal-portal layers cannot cover
           * it. Visually identical to before — same right:20, bottom:20. */
          position: 'fixed',
          right: 20,
          bottom: 20,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: 4,
          padding: 6,
          background: 'rgba(13,20,23,0.92)',
          border: '1px solid #1d2b2f',
          borderRadius: 12,
          backdropFilter: 'blur(8px)',
          fontFamily: 'JetBrains Mono, monospace',
          color: '#cdd9da',
          fontSize: 12,
          zIndex: 10000,
          userSelect: 'none',
          boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
        }}
      >
        <button
          type="button"
          data-testid="stellar-zoom-in"
          aria-label="zoom in"
          disabled={zoom >= ZOOM_MAX}
          onClick={() => applyZoom(zoom * 1.25)}
          style={{
            width: 36,
            height: 28,
            borderRadius: 7,
            background: zoom >= ZOOM_MAX ? '#0d1417' : '#102023',
            border: '1px solid #1d2b2f',
            color: '#3fe0c6',
            fontWeight: 600,
            cursor: zoom >= ZOOM_MAX ? 'not-allowed' : 'pointer',
            opacity: zoom >= ZOOM_MAX ? 0.4 : 1,
          }}
        >
          +
        </button>
        <div
          data-testid="stellar-zoom-scale"
          style={{
            textAlign: 'center',
            padding: '2px 0',
            color: '#9db0b5',
            letterSpacing: '0.04em',
          }}
        >
          {/* feat/stellar-zoom-sync — formatZoomLabel re-applies the unified
           *  clamp before formatting, so even if a future code path writes
           *  an out-of-range `zoom` value the readout cannot show 100x. */}
          {formatZoomLabel(zoom)}
        </div>
        <button
          type="button"
          data-testid="stellar-zoom-out"
          aria-label="zoom out"
          disabled={zoom <= ZOOM_MIN}
          onClick={() => applyZoom(zoom * 0.8)}
          style={{
            width: 36,
            height: 28,
            borderRadius: 7,
            background: zoom <= ZOOM_MIN ? '#0d1417' : '#102023',
            border: '1px solid #1d2b2f',
            color: '#3fe0c6',
            fontWeight: 600,
            cursor: zoom <= ZOOM_MIN ? 'not-allowed' : 'pointer',
            opacity: zoom <= ZOOM_MIN ? 0.4 : 1,
          }}
        >
          −
        </button>
      </div>
    </div>
  );
}

export default StellarGraph;
