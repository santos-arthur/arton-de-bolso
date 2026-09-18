import { MODULE_ID } from "./constantes.mjs";
import { registrarConfiguracoes } from "./configuracoes.mjs";
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
// As opções do módulo precisam existir antes de qualquer um lê-las, e o
// Foundry só aceita registrá-las aqui (ver configuracoes.mjs).
Hooks.once("init", () => {
  registrarConfiguracoes();
});

Hooks.once("ready", () => {
  registrarRelay();
});
