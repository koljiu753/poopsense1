import type { PetSnapshot } from "./api";
import "./pet-avatar.css";

export const PET_SKINS: { id: PetSnapshot["selected_skin"]; label: string }[] = [
  { id: "classic", label: "经典奶油" },
  { id: "blue_wave", label: "蓝色波浪" },
  { id: "pop_star", label: "波普明星" },
];

export function petSkinLabel(skin: PetSnapshot["selected_skin"]) {
  return PET_SKINS.find(item => item.id === skin)?.label ?? "经典奶油";
}

// An absent skin means the peer has not shared an appearance; never borrow ours.
export default function PetAvatar({ skin, label = "", size = "hero" }: {
  skin?: PetSnapshot["selected_skin"];
  label?: string;
  size?: "hero" | "room" | "map" | "mini";
}) {
  const knownSkin = PET_SKINS.some(item => item.id === skin) ? skin : undefined;
  return (
    <span className={`pet-avatar pet-avatar-${size} pet-look-${knownSkin ?? "neutral"}`}
      role={label ? "img" : undefined} aria-label={label || undefined}
      aria-hidden={label ? undefined : true} data-skin={knownSkin ?? "neutral"}>
      <span className="pet-avatar-backdrop" />
      <img src="/poop-island-agent-v1.webp" alt="" decoding="async" />
      {knownSkin === "blue_wave" ? <span className="pet-avatar-wave">≈</span> : null}
      {knownSkin === "pop_star" ? <span className="pet-avatar-star">★</span> : null}
      {knownSkin && knownSkin !== "classic" ? <span className="pet-avatar-pin">{knownSkin === "blue_wave" ? "≈" : "★"}</span> : null}
    </span>
  );
}
