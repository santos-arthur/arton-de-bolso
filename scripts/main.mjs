import { MODULE_ID } from "./constantes.mjs";
import { registrarRelay } from "./relay.mjs";

export { MODULE_ID };

/**
 * O módulo é só um relay: retransmite por socket a ficha simplificada de
 * Tormenta20 para o front-end standalone (projeto irmão
 * arton-de-bolso-frontend, hospedado à parte) — ver scripts/relay.mjs. Não
 * tem UI própria dentro do Foundry.
 *
 * O relay só faz algo no client do mestre (só ele retransmite as fichas
 * pros fronts conectados).
 */
Hooks.once("ready", () => {
  registrarRelay();
});
