/**
 * As opções do módulo, na tela de Configurar Módulos do Foundry.
 *
 * São de mundo (`scope: "world"`): quem decide é o mestre, e vale igual para
 * todo mundo que abrir o app. Uma preferência por jogador não faria sentido
 * aqui — "o inimigo mostra a barra de vida?" é uma decisão da mesa, não de
 * quem está olhando.
 *
 * Registrar precisa acontecer no `init` (é a regra do Foundry para settings),
 * bem antes de o relay subir — ver main.mjs.
 */

import { MODULE_ID } from "./constantes.mjs";

/** Barras de vida dos inimigos na tela de combate do app. */
export const VIDA_INIMIGOS = "mostrarVidaInimigos";

export function registrarConfiguracoes() {
  game.settings.register(MODULE_ID, VIDA_INIMIGOS, {
    name: "Mostrar Barras de Vida de Inimigos no Combate?",
    hint:
      "Ligado, o app mostra uma barra de vida (sem números) para os inimigos da " +
      "ordem de combate. Desligado, o inimigo aparece só com nome e iniciativa. " +
      "Os aliados mostram vida e mana sempre, de qualquer forma.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    // Muda o que o app mostra agora, não no próximo reload: quem estiver com
    // a tela de combate aberta recebe a lista nova em seguida.
    onChange: () => Hooks.callAll(`${MODULE_ID}.configuracaoMudou`)
  });
}

/**
 * O mestre liberou a barra de vida dos inimigos? Protegido por `try` porque
 * é lido dentro da montagem do payload, e uma setting ainda não registrada
 * (ordem de boot em um mundo estranho) não deve derrubar o combate inteiro.
 */
export function mostrarVidaInimigos() {
  try {
    return !!game.settings.get(MODULE_ID, VIDA_INIMIGOS);
  } catch {
    return false;
  }
}
