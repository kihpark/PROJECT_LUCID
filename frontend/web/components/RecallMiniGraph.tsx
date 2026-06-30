'use client';

/**
 * ★ REQ-011-v1 (★ PO 2026-06-30) — Recall 근거 미니 그래프.
 *
 * 시안 verbatim 의 캔버스 로직 (참고_Lucid Recall 리디자인.dc.html §drawGraph)
 * 을 React + Canvas 2D 패턴으로 재구현. 외부 라이브러리 0.
 *
 * 의뢰서 §4-4-(우) verbatim:
 *   "<canvas> 노드-링크 시각화 (중앙=질의 대상, 주변=목적어 노드,
 *    엣지 라벨=관계). 커서 호버 시 노드/엣지 하이라이트, 은은한 펄스."
 *
 * 의뢰서 §10 verbatim:
 *   "Canvas 2D. 중앙 노드(대상) + N개 목적어 노드를 각도 분배로 원형 배치.
 *    엣지 stroke + 중점에 관계 라벨(mono). 노드 = 채운 원 + 글로우.
 *    호버: 포인터-노드 거리 판정으로 하이라이트(엣지/노드 밝기↑).
 *    은은한 sin 펄스. requestAnimationFrame, DPR 캡 1.6, 60fps.
 *    리마운트(상태 전환) 대비: 매 프레임 clientWidth 변화 감지 시
 *    캔버스 백킹 사이즈 재계산."
 *
 * 의뢰서 §4-(Stellar 와의 관계) verbatim:
 *   "근거 그래프는 답 1개의 출처만 보여주는 수렴형·읽기전용 미니뷰.
 *    Stellar 수준의 인터랙션을 넣지 말 것."
 */

import { useEffect, useRef } from 'react';
import type { RecallExampleGraphNode } from '@/lib/recall-history';

interface Props {
  center: string;
  nodes: RecallExampleGraphNode[];
  height?: number;
}

export function RecallMiniGraph({
  center,
  nodes,
  height = 286,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ptrRef = useRef({ x: -999, y: -999 });
  const sizeRef = useRef({ w: 0, h: 0 });
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      const dpr = Math.min(1.6, window.devicePixelRatio || 1);
      const w = canvas.clientWidth || 440;
      const h = canvas.clientHeight || height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeRef.current = { w, h };
    };

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      ptrRef.current.x = e.clientX - r.left;
      ptrRef.current.y = e.clientY - r.top;
    };
    const onLeave = () => {
      ptrRef.current.x = -999;
      ptrRef.current.y = -999;
    };
    const onResize = () => resize();

    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    window.addEventListener('resize', onResize);
    resize();

    const N = nodes.length;
    const draw = (t: number) => {
      // 시안 verbatim — clientWidth 변화 감지 시 재계산.
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (cw > 0 && (cw !== sizeRef.current.w || ch !== sizeRef.current.h)) {
        resize();
      }
      const { w, h } = sizeRef.current;
      if (!w || !h) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }
      ctx.clearRect(0, 0, w, h);
      const cx = w * 0.5;
      const cy = h * 0.46;
      const R = Math.min(w, h) * 0.30;

      // positions — 시안 verbatim.
      const pts = nodes.map((n, i) => {
        const a = -Math.PI / 2 + (i / N) * Math.PI * 2 + 0.3;
        return {
          x: cx + Math.cos(a) * R,
          y: cy + Math.sin(a) * R * 0.86,
          label: n.label,
          edge: n.edge,
        };
      });

      // hover detection.
      let hover = -2;
      if (Math.hypot(ptrRef.current.x - cx, ptrRef.current.y - cy) < 30) {
        hover = -1;
      }
      pts.forEach((p, i) => {
        if (Math.hypot(ptrRef.current.x - p.x, ptrRef.current.y - p.y) < 30) {
          hover = i;
        }
      });

      // edges.
      ctx.lineWidth = 1.2;
      pts.forEach((p, i) => {
        const on = hover === i || hover === -1;
        ctx.strokeStyle = on
          ? 'rgba(45,212,191,0.65)'
          : 'rgba(45,212,191,0.22)';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        // predicate label.
        const mx = (cx + p.x) / 2;
        const my = (cy + p.y) / 2;
        ctx.font = "10px 'JetBrains Mono', monospace";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = on
          ? 'rgba(150,240,225,0.9)'
          : 'rgba(120,200,188,0.4)';
        ctx.fillText(p.edge, mx, my - 1);
      });

      // outer nodes.
      pts.forEach((p, i) => {
        const on = hover === i;
        const pulse = 1 + 0.06 * Math.sin(t * 0.003 + i);
        const rad = (on ? 9 : 6.5) * pulse;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad + (on ? 7 : 4), 0, 6.2832);
        ctx.fillStyle = on
          ? 'rgba(45,212,191,0.20)'
          : 'rgba(45,212,191,0.08)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, 6.2832);
        ctx.fillStyle = '#0a1013';
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = on ? '#7af0df' : '#2DD4BF';
        ctx.stroke();
        ctx.font = on
          ? "600 12px 'Pretendard', sans-serif"
          : "500 12px 'Pretendard', sans-serif";
        ctx.fillStyle = on ? '#eafffb' : '#aebfc2';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const ly = p.y + rad + 13;
        ctx.fillText(p.label, p.x, ly);
      });

      // center node.
      const cp = 1 + 0.05 * Math.sin(t * 0.0035);
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 30 * cp);
      cg.addColorStop(0, 'rgba(45,212,191,0.45)');
      cg.addColorStop(1, 'rgba(45,212,191,0)');
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.arc(cx, cy, 30 * cp, 0, 6.2832);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, 13 * cp, 0, 6.2832);
      ctx.fillStyle = '#2DD4BF';
      ctx.fill();
      ctx.font = "700 12.5px 'Pretendard', sans-serif";
      ctx.fillStyle = '#04130f';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(center, cx, cy);

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('resize', onResize);
    };
  }, [center, nodes, height]);

  return (
    <div
      data-testid="recall-mini-graph"
      style={{
        position: 'relative',
        background:
          'radial-gradient(420px 280px at 50% 42%, #0c1519, #090d11)',
        border: '1px solid #14211f',
        borderRadius: 12,
        overflow: 'hidden',
      }}
    >
      <canvas
        ref={canvasRef}
        data-testid="recall-mini-graph-canvas"
        style={{
          display: 'block',
          width: '100%',
          height: `${height}px`,
          cursor: 'crosshair',
        }}
      />
      <span
        className="font-mono"
        style={{
          position: 'absolute',
          left: 13,
          bottom: 11,
          fontSize: 10,
          color: '#3f5256',
          pointerEvents: 'none',
        }}
      >
        노드에 커서를 올려보세요
      </span>
    </div>
  );
}
