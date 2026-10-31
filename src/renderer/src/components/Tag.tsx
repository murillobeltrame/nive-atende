import type { ConversationState } from "../../../shared/types";
import { IconPhone, IconSpark, IconUser } from "./Icons";

export function IaTag() {
  return (
    <span className="tag tag-ia">
      <IconSpark size={10} />
      IA
    </span>
  );
}

export function HumanTag({ phone, label = "HUMANO" }: { phone?: boolean; label?: string }) {
  return (
    <span className="tag tag-human">
      {phone ? <IconPhone size={10} /> : <IconUser size={10} />}
      {label}
    </span>
  );
}

export function StateTag({ state }: { state: ConversationState }) {
  if (state === "ia") return <IaTag />;
  if (state === "humano") return <HumanTag />;
  if (state === "precisa_humano") return <span className="tag tag-need">PRECISA DE VOCÊ</span>;
  return <span className="tag tag-ignored">IGNORADO</span>;
}
