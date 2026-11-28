import type { ConversationState } from "../../../shared/types";
import { IconAlert, IconBan, IconPhone, IconSpark, IconUser } from "./Icons";

export function IaTag() {
  return (
    <span className="tag tag-ia">
      <IconSpark size={11} />
      IA
    </span>
  );
}

export function HumanTag({ phone, label = "Humano" }: { phone?: boolean; label?: string }) {
  return (
    <span className="tag tag-human">
      {phone ? <IconPhone size={11} /> : <IconUser size={11} />}
      {label}
    </span>
  );
}

export function StateTag({ state }: { state: ConversationState }) {
  if (state === "ia") return <IaTag />;
  if (state === "humano") return <HumanTag />;
  if (state === "precisa_humano")
    return (
      <span className="tag tag-need">
        <IconAlert size={11} />
        Precisa de você
      </span>
    );
  return (
    <span className="tag tag-ignored">
      <IconBan size={11} />
      Ignorado
    </span>
  );
}
