import { useId } from "react";
import "./demo-sample-visual.css";

const shapes = {
  elongated: { label: "长条形", asset: "/poop-shape-elongated-yellow-v2.webp" },
  compact: { label: "紧实成团", asset: "/poop-shape-compact-yellow-v2.webp" },
  scattered: { label: "分散颗粒", asset: "/poop-shape-scattered-yellow-v2.webp" },
  irregular: { label: "不规则形态", asset: "/poop-shape-irregular-yellow-v2.webp" },
};
const colors = { red: "红色", green: "绿色", blue: "蓝色", yellow: "黄色" };
const tintMatrices = {
  red: "0.3 0.7 0 0 0  0 0 1 0 0  0 0 1 0 0  0 0 0 1 0",
  green: "0 0 1 0 0  0.3 0.7 0 0 0  0 0 1 0 0  0 0 0 1 0",
  blue: "0 0 1 0 0  0 0 1 0 0  0.3 0.7 0 0 0  0 0 0 1 0",
};

/** Observation-only visual: never infer missing labels or health reliability. */
export default function DemoSampleVisual({ shape, color, className = "" }: {
  shape?: string | null; color?: string | null; className?: string;
}) {
  const id = `sample-tint-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const shapeKey = shape && Object.hasOwn(shapes, shape) ? shape as keyof typeof shapes : "unknown";
  const colorKey = color && Object.hasOwn(colors, color) ? color as keyof typeof colors : "unknown";
  const visual = shapeKey === "unknown" ? null : shapes[shapeKey];
  const label = `演示样本：${visual?.label ?? "形状未知"}，${colorKey === "unknown" ? "颜色未知" : colors[colorKey]}`;
  const tint = colorKey !== "unknown" && colorKey !== "yellow" ? tintMatrices[colorKey] : null;
  return <figure className={`demo-sample-visual ${className}`} data-demo-shape={shapeKey} data-demo-color={colorKey}>
    {tint && visual && <svg width="0" height="0" aria-hidden="true" className="demo-sample-filter">
      <defs><filter id={id} colorInterpolationFilters="sRGB">
        {/* Recolor the yellow body while retaining the original ink and brand accents. */}
        <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 1 -2 0 -0.25" result="yellowMask" />
        <feColorMatrix in="SourceGraphic" type="matrix" values={tint} result="tint" />
        <feComposite in="tint" in2="yellowMask" operator="in" result="body" />
        <feComposite in="SourceGraphic" in2="yellowMask" operator="out" result="rest" />
        <feMerge><feMergeNode in="rest" /><feMergeNode in="body" /></feMerge>
      </filter></defs>
    </svg>}
    {visual ? <img src={visual.asset} alt={label} style={tint ? { filter: `url(#${id})` } : undefined} />
      : <div className="demo-sample-unknown" role="img" aria-label={label}><span aria-hidden="true">?</span><small>形状尚未识别</small></div>}
    <figcaption><i aria-hidden="true" />{visual?.label ?? "形状未知"}<span>·</span>{colorKey === "unknown" ? "颜色未知" : colors[colorKey]}</figcaption>
  </figure>;
}
