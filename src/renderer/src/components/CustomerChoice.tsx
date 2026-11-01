// Escolha do cliente quando a reserva veio com um nome parecido com cadastros existentes.
import type { Reservation } from "../../../shared/types";

export type Choice = { customerId?: string | null; createNew?: boolean } | undefined;

export function CustomerChoice({ r, value, onChange }: { r: Reservation; value: Choice; onChange: (c: Choice) => void }) {
  if (r.customerStatus !== "confirm" || r.status === "created") return null;
  const name = `cust-${r.id}`;
  return (
    <fieldset className="cust-choice">
      <legend>
        O cliente informou o nome <b>{r.customerName}</b>. É algum destes cadastros?
      </legend>
      {r.customerCandidates.map((c) => (
        <label key={c.id} className="check-inline">
          <input type="radio" name={name} checked={value?.customerId === c.id} onChange={() => onChange({ customerId: c.id })} />
          {c.name}
        </label>
      ))}
      <label className="check-inline">
        <input type="radio" name={name} checked={value?.createNew === true} onChange={() => onChange({ createNew: true })} />
        Nenhum destes: cadastrar <b>{r.customerName}</b> como cliente novo
      </label>
    </fieldset>
  );
}

export function needsChoice(r: Reservation, value: Choice): boolean {
  return r.customerStatus === "confirm" && !value?.customerId && !value?.createNew;
}
