/**
 * Adaptador de dados do sistema `tormenta20`.
 *
 * ÚNICO arquivo que conhece os caminhos de `actor.system.*` / `item.system.*`.
 * Os caminhos abaixo foram confirmados lendo o código-fonte do sistema
 * instalado (`tormenta20.mjs`, versão 1.6.2 — a primeira para o Foundry v14)
 * — os data models (`CharacterData`, `WeaponData`, `EquipmentData`, `PowerData`,
 * `SpellData`, `ClassData`, etc.) e as funções `prepareSkill`/`prepareDefense`/
 * a lista de efeitos usada no tooltip de PV/PM/Defesa da própria ficha do
 * sistema — não apenas inspecionando um personagem ao vivo. Ver
 * docs/investigacao-tormenta20.md para o histórico da investigação original.
 *
 * Nota: `atributos` (FOR/DES/CON/INT/SAB/CAR) e `attributes` (PV/PM/defesa/
 * movimento/nível) são dois campos top-level distintos no sistema — fácil de
 * confundir.
 *
 * Foundry v14 / Tormenta20 1.6
 * ----------------------------
 * A virada do sistema para a v14 mexeu em tudo que este arquivo lê sobre
 * Active Effects, e é de propósito que não há caminho de compatibilidade com
 * a geração anterior: o T20 1.6 exige o Foundry 14 e o 1.5 recusa rodar nele
 * (`maximum: 13`), então nunca existe um mundo em que os dois formatos
 * convivam. O que mudou, e onde:
 *
 *   - `effect.changes` virou `effect.system.changes`, e o `mode` numérico de
 *     cada mudança virou um `type` em texto (`CONST.ACTIVE_EFFECT_CHANGE_TYPES`);
 *   - as propriedades que o sistema guardava em `flags.tormenta20` do efeito
 *     ("de uso", custo, escopos, itens) passaram a campos próprios em
 *     `effect.system.onuse` / `effect.system.abilityUse`;
 *   - `duration` deixou de ter `rounds`/`turns` separados: agora é
 *     `{ value, units, expiry }`, com eventos de expiração (fim de cena,
 *     efeito sustentado) no lugar dos truques de contagem alta;
 *   - `CONFIG.statusEffects` deixou de ser uma lista e passou a ser indexado
 *     pelo id da condição;
 *   - `system.rolltags` (e as outras listas de tags do item) viraram `Set`,
 *     que não tem `.some`/`.filter` — só iteração.
 */

import { MODULE_ID } from "./constantes.mjs";

function warn(mensagem) {
  console.warn(`${MODULE_ID} | ${mensagem}`);
}

/** Texto localizado do sistema, com um padrão para quando o i18n não responder. */
function t20Localize(chave, padrao) {
  try {
    const texto = game.i18n?.localize(chave);
    return texto && texto !== chave ? texto : padrao;
  } catch {
    return padrao;
  }
}

function t20Config() {
  return CONFIG?.T20 ?? {};
}

function formatarBonus(valor) {
  const n = Number(valor) || 0;
  return n >= 0 ? `+${n}` : `${n}`;
}

// ---------------------------------------------------------------------------
// Bônus nomeados (Active Effects) — mesma fonte que a própria ficha do
// sistema usa pra montar o tooltip de cada campo: `actor.modifiedFields`
// (getter em tormenta20.mjs, `get modifiedFields()`), que agrupa por `key` as
// mudanças dos Active Effects aplicados ao ator — ex:
// "system.attributes.defesa.bonus", "system.pericias.furt.bonus". Os
// caminhos exatos foram confirmados lendo onde a própria ficha chama
// `fieldBonuses` nos templates .hbs do sistema. Preferimos isso a cair num
// "Outros" genérico sempre que o sistema efetivamente sabe de onde vem o bônus
// — o que sobrar sem nome vira mesmo um "Outros" no final de cada função.
// ---------------------------------------------------------------------------

/**
 * Só as mudanças que **somam** entram na decomposição: uma que substitui ou
 * multiplica não é uma parcela do total. No v14 o campo virou texto
 * (`CONST.ACTIVE_EFFECT_CHANGE_TYPES.ADD`); o literal evita depender da ordem
 * em que o core popula o `CONST`.
 */
const TIPO_MUDANCA_SOMA = "add";

/**
 * O valor de um Active Effect raramente é um número cru — costuma ser uma
 * fórmula no formato do Foundry (ex: "@car", "@meionivel", "@nivel/2"), que é
 * como o próprio sistema guarda ("Esquiva Sagaz" do Bix, por exemplo). Usamos
 * as mesmas APIs do core que o sistema usa pra resolver isso.
 *
 * Devolve `null` quando não dá pra reduzir a um número (ex: fórmula com
 * dados) — aí o valor cai no "Outros" residual em vez de aparecer como um
 * bônus nomeado errado, de valor zero.
 */
function avaliarFormula(valorBruto, rollData) {
  const texto = String(valorBruto ?? "").trim();
  if (!texto) return null;

  const numero = Number(texto);
  if (Number.isFinite(numero)) return numero;

  try {
    return Roll.safeEval(Roll.replaceFormulaData(texto, rollData, { missing: "0" }));
  } catch {
    return null;
  }
}

/**
 * Válido só durante uma montagem de ficha (ver `getFichaCompleta`), que é
 * síncrona: nada muda no ator entre a primeira e a última leitura. Fora dali
 * fica vazio, e cada consulta remonta o mapa — que é o que o getter do
 * sistema fazia a cada acesso de qualquer forma.
 */
const cacheDeModificadores = new WeakMap();

/**
 * As mudanças de todos os efeitos ativos, agrupadas por chave — o mesmo que o
 * `actor.modifiedFields` do sistema devolve, montado aqui.
 *
 * Não é duplicação por gosto: o getter do sistema tem a linha
 * `if ([3, 4].includes(ch.value)) continue;`, que descarta qualquer mudança
 * cujo **valor** seja 3 ou 4 (a intenção era claramente filtrar os antigos
 * `mode` 3 e 4). Isso era inofensivo enquanto os valores eram texto — `"3"`
 * não é `3` —, mas o Foundry v14 converte o que parece número ao migrar o
 * efeito, e de repente todo bônus de +3 ou +4 sumiu do tooltip da ficha e,
 * por tabela, da decomposição que o app mostra. Bônus de +3/+4 em atributo
 * são dos mais comuns no jogo.
 *
 * Enquanto o sistema não corrigir, montamos a lista aqui — mesmo critério
 * (`appliedEffects` + `modifiesActor`), sem o filtro.
 */
function modificadoresPorChave(actor) {
  const doCache = cacheDeModificadores.get(actor);
  if (doCache) return doCache;

  const mapa = {};
  for (const efeito of actor.appliedEffects ?? []) {
    if (!efeito.modifiesActor) continue;
    for (const mudanca of mudancasDoEfeito(efeito)) {
      const chave = mudanca?.key;
      if (!chave) continue;
      (mapa[chave] ??= []).push({ label: efeito.name, value: mudanca.value, type: mudanca.type });
    }
  }
  return mapa;
}

function getModificadoresNomeados(actor, chave, rollData = actor.getRollData()) {
  const lista = modificadoresPorChave(actor)[chave];
  if (!lista) return [];
  return lista
    .filter((m) => m.type === TIPO_MUDANCA_SOMA)
    .map((m) => ({ rotulo: m.label, valor: avaliarFormula(m.value, rollData) }))
    // Descarta o que não avaliou e o que deu zero (efeito inativo no momento):
    // um "Fulano +0" na lista é só ruído pro jogador.
    .filter((m) => m.valor);
}

// ---------------------------------------------------------------------------
// Tabelas (delegadas ao CONFIG.T20 do próprio sistema, já localizado em pt-BR)
// ---------------------------------------------------------------------------

const ATRIBUTOS_FALLBACK = ["for", "des", "con", "int", "sab", "car"];

export function getAtributosChaves() {
  const cfg = t20Config().atributos;
  return cfg ? Object.keys(cfg) : ATRIBUTOS_FALLBACK;
}

/** Nome completo do atributo (ex: "Força"), como o próprio sistema localiza. */
export function localizeAtributo(chave) {
  return t20Config().atributos?.[chave] ?? chave.toUpperCase();
}

/** Sigla do atributo (ex: "FOR"), como o próprio sistema localiza. */
export function localizeAtributoAbr(chave) {
  return t20Config().atributosAbr?.[chave] ?? chave.toUpperCase();
}

// Mapeamento de moedas confirmado lendo `schemaCurrency` em tormenta20.mjs: os
// nomes dos campos (tc/tl/to/tp) NÃO seguem a sigla do metal — é uma
// inconsistência do próprio sistema, não um erro deste adaptador.
// Só as duas moedas que a mesa usa, da mais valiosa para a menos — é a ordem
// em que se lê dinheiro e em que o front desenha os campos. O Tibar (T$) é a
// moeda de prata e serve de unidade base; 1 TO = 10 T$.
//
// `tc` (cobre) e `tl` (platina) existem no sistema e continuam guardados no
// Actor, apenas não são exibidos nem editados aqui.
const VALOR_TO_EM_TIBAR = 10;

const MOEDAS = [
  { chave: "to", sigla: "TO", label: "Tibar de Ouro", emTibar: VALOR_TO_EM_TIBAR },
  { chave: "tp", sigla: "T$", label: "Tibar de Prata", emTibar: 1 }
];

// ---------------------------------------------------------------------------
// Leitura de recursos do personagem
// ---------------------------------------------------------------------------

export function getNivel(actor) {
  return actor.system?.attributes?.nivel?.value ?? null;
}

/** XP é opcional: só é exibido se o sistema tiver os três campos preenchidos. */
/** Some quando a mesa usa "Avanço por Marcos" (config. do próprio sistema tormenta20) — nesse modo os personagens nem acumulam XP de verdade. */
export function getXp(actor) {
  if (game.settings.get("tormenta20", "disableExperience")) return null;
  const xp = actor.system?.attributes?.nivel?.xp;
  if (!xp || !xp.proximo) return null;
  return { atual: xp.value ?? 0, proximo: xp.proximo };
}

function getTreinoBonus(actor) {
  return actor.system?.attributes?.treino ?? 0;
}

/**
 * Decompõe o máximo de PV/PM em "Classe X nível" + "Constituição" (só para
 * PV), replicando a lista que a própria ficha do sistema monta para o
 * tooltip de PV/PM (`prepareBaseData`/tooltip em tormenta20.mjs). Sempre
 * fecha com uma linha "Outros" reconciliando qualquer diferença contra o
 * `.max` real — efeitos ativos raros que não valem a pena replicar aqui
 * aparecem nessa linha em vez de serem ignorados silenciosamente.
 */
function decomporRecurso(actor, tipo) {
  const rollData = actor.getRollData();
  const classes = actor.items.filter((i) => i.type === "classe");
  const totalNiveis = classes.reduce((soma, c) => soma + (Number(c.system?.niveis) || 0), 0);

  const itens = classes.map((c) => {
    const niveis = Number(c.system?.niveis) || 0;
    const porNivel = Number(c.system?.[`${tipo}PorNivel`]) || 0;
    const inicial = tipo === "pv" && c.system?.inicial ? porNivel * 3 : 0;
    return { rotulo: `${c.name} ${niveis}`, valor: inicial + niveis * porNivel };
  });

  if (tipo === "pv" && totalNiveis > 0) {
    const con = actor.system?.atributos?.con;
    if (con) {
      itens.push({ rotulo: `Constituição (${formatarBonus(con.value)} × nível)`, valor: con.value * totalNiveis });
    }
  }

  // Atributo-chave que a classe soma ao total (ex: Druida soma Sabedoria no
  // PM, Paladino soma Carisma) — o sistema marca isso em
  // `attributes.<pv|pm>.atributos.<chave>` e soma o `.value` uma vez, não por
  // nível (confirmado em `preparePVPM`). Para PV o CON já entra acima, por
  // nível, e nem aparece nesse mapa de flags.
  const atributosQueSomam = actor.system?.attributes?.[tipo]?.atributos ?? {};
  for (const [chave, marcado] of Object.entries(atributosQueSomam)) {
    if (!marcado) continue;
    const valor = actor.system?.atributos?.[chave]?.value ?? 0;
    if (valor) itens.push({ rotulo: localizeAtributo(chave), valor });
  }

  // Bônus por nível: o sistema soma esses valores DENTRO do laço de níveis
  // (ver `preparePVPM`), então cada um vale × a quantidade de níveis que se
  // aplica — `nivel` em todos, `nivelPar`/`nivelImpar` só nas posições par/
  // ímpar da contagem acumulada entre as classes. É daqui que vinha o
  // "Outros" da Mari (multiclasse nível 7: 4 níveis ímpares).
  const multiplicadores = { nivel: totalNiveis, nivelPar: Math.floor(totalNiveis / 2), nivelImpar: Math.ceil(totalNiveis / 2) };

  for (const [campo, multiplicador] of Object.entries(multiplicadores)) {
    if (!multiplicador) continue;
    const caminho = `system.attributes.${tipo}.bonus.${campo}`;

    for (const m of getModificadoresNomeados(actor, caminho, rollData)) {
      itens.push({ rotulo: m.rotulo, valor: m.valor * multiplicador });
    }

    // O índice 0 do array é o campo digitado à mão na ficha (os demais são
    // acrescentados pelos Active Effects, já cobertos acima) — não tem nome
    // de origem pra mostrar.
    const manual = avaliarFormula(actor.system?.attributes?.[tipo]?.bonus?.[campo]?.[0], rollData) ?? 0;
    if (manual) itens.push({ rotulo: "Bônus por nível", valor: manual * multiplicador });
  }

  // Bônus fixo de itens/poderes/condições (ex: "+10 PV") via Active Effect —
  // caminho confirmado no template resources.hbs do sistema.
  itens.push(...getModificadoresNomeados(actor, `system.attributes.${tipo}.bonus.total`, rollData));

  const manualTotal = avaliarFormula(actor.system?.attributes?.[tipo]?.bonus?.total?.[0], rollData) ?? 0;
  if (manualTotal) itens.push({ rotulo: "Bônus", valor: manualTotal });

  const max = actor.system?.attributes?.[tipo]?.max ?? 0;
  const somaConhecida = itens.reduce((soma, item) => soma + item.valor, 0);
  const residual = max - somaConhecida;
  if (residual) itens.push({ rotulo: "Outros", valor: residual });

  return itens;
}

export function getPV(actor) {
  const pv = actor.system?.attributes?.pv;
  if (!pv) warn(`Não encontrei PV em "${actor.name}" (system.attributes.pv)`);
  return {
    atual: pv?.value ?? null,
    max: pv?.max ?? null,
    temp: pv?.temp ?? 0,
    itensMax: decomporRecurso(actor, "pv")
  };
}

export function getPM(actor) {
  const pm = actor.system?.attributes?.pm;
  if (!pm) warn(`Não encontrei PM em "${actor.name}" (system.attributes.pm)`);
  return {
    atual: pm?.value ?? null,
    max: pm?.max ?? null,
    temp: pm?.temp ?? 0,
    itensMax: decomporRecurso(actor, "pm")
  };
}

/** Recursos genéricos configurados pelo mestre (`system.resources.*`: primary/secondary/tertiary/...). */
// Nunca exibidos como "recurso extra" independente do que o mestre configurar
// nesses slots — Falha na Morte/Pontos de Sombra/Catarse são mecânicas
// específicas demais pra fazer sentido como um contador genérico na tela.
const RECURSOS_OCULTOS = new Set(["deathsave", "shadow", "catarse"]);

/**
 * Preferências que o jogador marca na engrenagem da ficha
 * (`flags.tormenta20.sheet`) — o app segue as mesmas, para a ficha no celular
 * não mostrar coisa diferente da ficha no Foundry.
 *
 * Flag ausente conta como desmarcada, que é o comportamento do próprio
 * sistema: ele lê o valor cru com `getFlag` e testa com `{{#if}}`, então
 * `undefined` não mostra recurso nenhum e não esconde perícia nenhuma.
 */
function getPreferenciasDaFicha(actor) {
  const sheet = actor.flags?.tormenta20?.sheet ?? {};
  return {
    mostrarRecursos: !!sheet.showResources,
    esconderNaoTreinadas: !!sheet.esconderPericias,
    esconderOficios: !!sheet.esconderOficios
  };
}

/**
 * Quem manda é o nome: entra o slot que o mestre batizou, fique ele como
 * ficar. Um recurso chamado "Fúria" aparece mesmo zerado — gastar até o fim é
 * justamente quando se precisa vê-lo na tela —, e um slot sem nome não
 * aparece nem com valor, porque "12" sozinho, sem dizer 12 do quê, não serve
 * pra nada.
 *
 * Máximo 0 vira `null` e a tela mostra só o valor, sem o "/ 0".
 */
export function getRecursosGenericos(actor) {
  if (!getPreferenciasDaFicha(actor).mostrarRecursos) return [];
  const resources = actor.system?.resources ?? {};
  return Object.entries(resources)
    .filter(([chave, dado]) => dado && !RECURSOS_OCULTOS.has(chave) && (dado.label ?? "").trim())
    .map(([chave, dado]) => ({
      chave,
      label: dado.label.trim(),
      atual: dado.value ?? 0,
      max: dado.max || null
    }));
}

/** Decompõe a Defesa: Base, atributo (normalmente DES), armaduras equipadas, Outros/Condição. */
/**
 * Defesa decomposta, seguindo a mesma ordem e as mesmas regras que o sistema
 * usa no tooltip da ficha (o `case "defesa"` em tormenta20.mjs):
 *
 *   Base · Metade do Nível · atributo · armaduras e escudos · Outros · efeitos
 *
 * Duas regras que não são óbvias e vêm de lá:
 *
 * - **Armadura pesada anula o atributo.** Quem veste armadura pesada não soma
 *   Destreza (ou o atributo configurado) na Defesa.
 * - **Metade do Nível só entra** com a opção "Defesa progressiva" ligada no
 *   mundo, e apenas para personagens.
 *
 * O que conta como "equipado" também segue a configuração: com slots ligados,
 * é o slot ocupado; sem eles, o antigo booleano.
 */
export function getDefesa(actor) {
  const defesa = actor.system?.attributes?.defesa;
  if (!defesa) return { total: null, itens: [] };

  const comSlots = usaSlots();
  const protecoes = actor.items
    .filter((item) => item.type === "equipamento" && item.system?.armadura?.value)
    .filter((item) => (comSlots ? Number(item.system?.equipado2?.slot) > 0 : !!item.system?.equipado));

  const vestindoPesada = protecoes.some((item) => item.system?.tipo === "pesada");

  let defesaProgressiva = false;
  try {
    defesaProgressiva = actor.type === "character" && !!game.settings.get("tormenta20", "progressiveDefense");
  } catch {
    defesaProgressiva = false;
  }

  const itens = [{ rotulo: "Base", valor: defesa.base ?? 10 }];

  if (defesaProgressiva) {
    const meioNivel = Math.floor((getNivel(actor) ?? 0) / 2);
    if (meioNivel) itens.push({ rotulo: "Metade do Nível", valor: meioNivel });
  }

  if (defesa.atributo && !vestindoPesada) {
    const atributo = actor.system?.atributos?.[defesa.atributo];
    if (atributo) itens.push({ rotulo: localizeAtributo(defesa.atributo), valor: atributo.value });
  }

  for (const item of protecoes) {
    itens.push({ rotulo: item.name, valor: Number(item.system.armadura.value) || 0 });
  }

  if (defesa.outros) itens.push({ rotulo: "Outros", valor: defesa.outros });
  if (defesa.condi) itens.push({ rotulo: "Condição", valor: defesa.condi });

  // "system.attributes.defesa.bonus" é o campo que os Active Effects de
  // poderes/itens/condições realmente usam — `.outros` é só o número digitado
  // à mão na ficha, sem origem pra nomear.
  itens.push(...getModificadoresNomeados(actor, "system.attributes.defesa.bonus"));

  const total = defesa.value ?? itens.reduce((soma, item) => soma + item.valor, 0);

  // Rede de segurança: se ainda sobrar diferença, ela aparece em vez de a
  // soma não fechar com o número que o sistema calculou.
  const residual = total - itens.reduce((soma, item) => soma + item.valor, 0);
  if (residual) itens.push({ rotulo: "Outros efeitos", valor: residual });

  return { total, itens };
}


/**
 * Onde os Active Effects de deslocamento pousam. São várias porque o sistema
 * aceita escrever o efeito de três formas — direto no tipo de movimento, no
 * `.bonus` (soma) ou no `.base` —, e ainda com `*` no lugar do tipo, que é
 * como as condições de carga e lentidão vêm. `modifiedFields` guarda a chave
 * como o efeito a escreveu, então varremos todas.
 */
const CHAVES_EFEITO_DESLOCAMENTO = [
  "system.attributes.movement.walk",
  "system.attributes.movement.walk.bonus",
  "system.attributes.movement.walk.base",
  "system.attributes.movement.*",
  "system.attributes.movement.*.bonus",
  "system.attributes.movement.*.base"
];

/** Armadura pesada vestida — o -3 do sistema depende dela, não de efeito. */
function vestindoArmaduraPesada(actor) {
  const comSlots = usaSlots();
  return actor.items.some(
    (item) =>
      item.type === "equipamento" &&
      item.system?.tipo === "pesada" &&
      (comSlots ? Number(item.system?.equipado2?.slot) > 0 : !!item.system?.equipado)
  );
}

export function getMovimento(actor) {
  const movement = actor.system?.attributes?.movement;
  const caminhada = movement?.walk;
  // `value` é o deslocamento de verdade — o `base` da raça/tamanho já com os
  // efeitos ativos somados (agilidade, carga pesada, lentidão, o que houver).
  // `base` sozinho ignora tudo isso, e era o que a ficha mostrava aqui. A
  // ficha do próprio sistema usa `value` (ver `_prepareMovementSpeed`).
  //
  // `??` e não `||`: deslocamento zero é um estado real (imóvel, agarrado) e
  // precisa aparecer como 0, não cair no valor base como se nada tivesse
  // acontecido.
  const valor = caminhada?.value ?? caminhada?.base ?? null;
  const unidade = t20Config().movementUnits?.[movement?.unit] ?? movement?.unit ?? "m";

  // Mesma decomposição que Defesa e atributos já mostram: de onde saiu o
  // número. Sem ela o jogador vê "6 metros" e não tem como saber que são os 9
  // da raça menos a sobrecarga da mochila.
  //
  // As duas penalidades de -3 abaixo NÃO são Active Effects: o sistema as
  // aplica na mão ao derivar o deslocamento (a linha que faria isso por efeito
  // está comentada no código dele). Sem repeti-las aqui, elas cairiam no
  // "Outros efeitos" — que foi exatamente o que aconteceu na primeira versão.
  const itens = [];
  if (caminhada) {
    itens.push({ rotulo: "Base", valor: caminhada.base ?? 0 });

    const rollData = actor.getRollData();
    itens.push(
      ...CHAVES_EFEITO_DESLOCAMENTO.flatMap((chave) => getModificadoresNomeados(actor, chave, rollData))
    );

    const tags = movement?.tags;
    if (vestindoArmaduraPesada(actor) && !tags?.has?.("ignora-armadura")) {
      itens.push({ rotulo: "Armadura pesada", valor: -3 });
    }
    if (actor.system?.attributes?.carga?.encumbered && !tags?.has?.("ignora-carga")) {
      itens.push({ rotulo: "Sobrecarregado", valor: -3 });
    }

    // "Lento" corta pela metade e "Caído" limita a 1,5m — são transformações
    // do total, não parcelas. Entram como a diferença que falta pro número
    // fechar, com o nome da condição que a causou.
    const somado = itens.reduce((soma, item) => soma + item.valor, 0);
    const residual = (valor ?? 0) - somado;
    if (residual) {
      const statuses = actor.statuses;
      const rotulo = statuses?.has?.("caido")
        ? "Caído"
        : statuses?.has?.("lento")
          ? "Lento"
          : "Outros efeitos";
      itens.push({ rotulo, valor: residual });
    }
  }

  return { valor, unidade, itens };
}

/**
 * Onde um Active Effect de atributo pode pousar. São quatro porque o sistema
 * aceita escrever de quatro formas, e `modifiedFields` guarda a chave como o
 * efeito a escreveu:
 *
 *   - `.value`, que soma no total já pronto;
 *   - `.bonus`, o mesmo campo do "Bônus Temporário" digitado na ficha;
 *   - as duas com `*` no lugar do atributo — é como se escreve "+1 em todos
 *     os atributos" (ver a lista de curingas em `_prepareProxyChange`, no
 *     sistema).
 *
 * Mesma ideia de `CHAVES_EFEITO_DESLOCAMENTO`, logo acima.
 */
function chavesDeEfeitoDoAtributo(chave, campo) {
  return [`system.atributos.${chave}.${campo}`, `system.atributos.*.${campo}`];
}

/**
 * Atributo (FOR/DES/...) decomposto para o popover de detalhe, na mesma ordem
 * que o tooltip da ficha do sistema usa (ver o helper `fieldBonuses`):
 *
 *   Valor Base · Racial · Bônus Temporário · efeitos
 *
 * A lista fecha com um "Outros efeitos" reconciliando o que sobrar contra o
 * `value` real — como Defesa, perícia e PV/PM já faziam. Sem ele, um efeito
 * que o sistema aplicasse por um caminho não previsto aqui sumia da conta em
 * silêncio, e a soma das linhas não batia com o número mostrado ao lado.
 */
export function getAtributo(actor, chave) {
  const dado = actor.system?.atributos?.[chave];
  if (!dado) {
    warn(`Não encontrei o atributo "${chave}" em "${actor.name}" (system.atributos.${chave})`);
    return { mod: null, itens: [] };
  }

  const rollData = actor.getRollData();
  const itens = [{ rotulo: "Valor Base", valor: dado.base ?? 0 }];
  if (dado.racial) itens.push({ rotulo: "Racial", valor: dado.racial });

  // As duas consultas são separadas porque os destinos se comportam
  // diferente: o que cai em `.bonus` já está dentro do campo `bonus`, e o que
  // cai em `.value` só aparece no total.
  const noBonus = chavesDeEfeitoDoAtributo(chave, "bonus").flatMap((caminho) =>
    getModificadoresNomeados(actor, caminho, rollData)
  );
  const noValor = chavesDeEfeitoDoAtributo(chave, "value").flatMap((caminho) =>
    getModificadoresNomeados(actor, caminho, rollData)
  );

  // O campo `bonus` carrega duas coisas ao mesmo tempo: o número que o
  // jogador digita na ficha e o que os efeitos somaram nele. Descontando os
  // efeitos, o que sobra é o que foi digitado.
  const manual = (dado.bonus ?? 0) - noBonus.reduce((soma, m) => soma + m.valor, 0);
  if (manual) itens.push({ rotulo: "Bônus Temporário", valor: manual });

  itens.push(...noBonus, ...noValor);

  const total = dado.value ?? 0;
  const residual = total - itens.reduce((soma, item) => soma + item.valor, 0);
  if (residual) itens.push({ rotulo: "Outros efeitos", valor: residual });

  return { mod: dado.value ?? null, itens };
}

// ---------------------------------------------------------------------------
// Traços de personagem (tela "Detalhes")
// ---------------------------------------------------------------------------

export function getTamanho(actor) {
  const chave = actor.system?.tracos?.tamanho;
  return t20Config().actorSizes?.[chave] ?? chave ?? "—";
}

/** Réplica de `_prepareSenses` do próprio sistema: troca as chaves conhecidas pelo label e acrescenta o texto livre. */
export function getSentidos(actor) {
  const sentidos = actor.system?.attributes?.sentidos;
  const valores = [...(sentidos?.value ?? [])];
  const senses = t20Config().senses ?? {};
  const resultado = valores.map((chave) => senses[chave] ?? chave);
  if (sentidos?.custom) resultado.push(sentidos.custom);
  return resultado;
}

/** Resistências/imunidades/vulnerabilidades a dano, uma tag por tipo de dano relevante (`system.tracos.resistencias.*`). */
export function getResistencias(actor) {
  const resistencias = actor.system?.tracos?.resistencias ?? {};
  const damageTypes = t20Config().damageTypes ?? {};
  const resultado = [];

  for (const [chave, dado] of Object.entries(resistencias)) {
    if (!dado) continue;
    const nome = damageTypes[chave] ?? chave;
    if (dado.imunidade) resultado.push(`${nome} (Imune)`);
    else if (dado.value) resultado.push(`${nome} (RD ${dado.value})`);
    if (dado.vulnerabilidade) resultado.push(`${nome} (Vulnerável)`);
  }

  return resultado;
}

/**
 * Imunidade a condições (`system.tracos.ic`) — os nomes vêm de
 * `CONFIG.statusEffects`, que no v14 é indexado pelo id da condição (o
 * sistema o remonta a partir do compêndio "Condições" que ele cria no mundo).
 */
export function getImunidadesCondicoes(actor) {
  const ic = actor.system?.tracos?.ic;
  const ids = [...(ic?.value ?? [])];
  const status = CONFIG?.statusEffects ?? {};
  const resultado = ids.map((id) => {
    const nome = status[id]?.name;
    return nome ? t20Localize(nome, nome) : id;
  });
  if (ic?.custom) resultado.push(ic.custom);
  return resultado;
}

function getProficiencias(actor, campo, tabela) {
  const dado = actor.system?.tracos?.[campo];
  const chaves = dado?.value ?? [];
  const resultado = chaves.map((chave) => tabela?.[chave] ?? chave);
  if (dado?.custom) resultado.push(dado.custom);
  return resultado;
}

export function getProficienciaArmas(actor) {
  return getProficiencias(actor, "profArmas", t20Config().profArmas);
}

export function getProficienciaArmaduras(actor) {
  return getProficiencias(actor, "profArmaduras", t20Config().profArmaduras);
}

// ---------------------------------------------------------------------------
// Detalhes (cabeçalho): raça, origem, classe, divindade
// ---------------------------------------------------------------------------

export function getRaca(actor) {
  return actor.system?.detalhes?.raca || actor.items.find((i) => i.type === "race")?.name || "";
}

export function getOrigem(actor) {
  return actor.system?.detalhes?.origem || "";
}

export function getDivindade(actor) {
  return actor.system?.detalhes?.divindade || "";
}

/**
 * Classe(s) do personagem: "Ladino" numa classe só, "Ladino 6 / Guerreiro 4"
 * em multiclasse.
 *
 * Com uma classe só o nível dela é o nível do personagem, que já aparece ao
 * lado — "Nível 10 · Ladino 10" repete o mesmo número. O nível por classe só
 * informa alguma coisa quando há mais de uma para dividir.
 */
export function getClasses(actor) {
  const classes = actor.items.filter((i) => i.type === "classe");
  if (classes.length === 1) return classes[0].name;
  return classes.map((c) => `${c.name} ${c.system?.niveis ?? ""}`.trim()).join(" / ");
}

// ---------------------------------------------------------------------------
// Perícias — fórmula decomposta, nunca rolada
// ---------------------------------------------------------------------------

export function getPericias(actor) {
  const cfg = t20Config().pericias ?? {};
  // Ofício é o que o sistema marca como `crafting` — mesma fonte que ele usa
  // pra montar `CONFIG.T20.oficios`, em vez de uma lista de chaves nossa que
  // ficaria para trás na próxima perícia de ofício que o sistema criar.
  const oficios = t20Config().oficios ?? new Set();
  const { esconderNaoTreinadas, esconderOficios } = getPreferenciasDaFicha(actor);

  return Object.keys(cfg)
    .filter((chave) => chave !== "ofic")
    .map((chave) => {
      const dado = actor.system?.pericias?.[chave];
      return {
        chave,
        label: cfg[chave]?.label ?? dado?.label ?? chave,
        treinado: !!dado?.treinado,
        // `st` do próprio ator na frente da config do sistema: é ele que o
        // sistema consulta, e pode ter sido mexido por um poder do personagem.
        somenteTreinado: dado?.st ?? !!cfg[chave]?.trainedOnly,
        valorFormatado: formatarBonus(dado?.value ?? 0)
      };
    })
    // Espelha `_prepareSkills` do sistema: treino escondido só atinge quem
    // exige treino, e ofício escondido só atinge ofício — nos dois casos,
    // estar treinado devolve a perícia à lista.
    .filter(({ chave, treinado, somenteTreinado }) => {
      const passaTreino = !esconderNaoTreinadas || !somenteTreinado || treinado;
      const passaOficio = !esconderOficios || !oficios.has(chave) || treinado;
      return passaTreino && passaOficio;
    })
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
}

/**
 * Monta a fórmula decomposta de uma perícia (ex: "1d20 + 3 (DES) + 2 (Treino)
 * − 1 (Outros)") a partir dos componentes conhecidos do sistema (atributo,
 * treino, outros, condição). Qualquer diferença entre a soma desses
 * componentes e o `.value` total (efeitos ativos, penalidade de armadura,
 * modificador de tamanho, etc. — ver `prepareSkill` em tormenta20.mjs) entra
 * como uma linha final "Outros efeitos", nunca é descartada em silêncio.
 */
export function getFormulaPericia(actor, chave) {
  const dado = actor.system?.pericias?.[chave];
  const cfg = t20Config().pericias?.[chave];
  if (!dado) return null;

  const atributoChave = dado.atributo ?? cfg?.abl;
  const atributoMod = actor.system?.atributos?.[atributoChave]?.value ?? 0;
  const treino = dado.treinado ? getTreinoBonus(actor) : 0;
  const ehAtaque = ["luta", "pont"].includes(chave);
  const ehResistencia = ["fort", "refl", "vont"].includes(chave);

  // Modificadores globais (campanha inteira) que o mestre configura em
  // "Efeitos: Modificador Testes de Perícia" — caminhos confirmados em
  // `prepareSkill` no código-fonte do sistema. `rollData` é montado uma vez
  // só e reaproveitado nas seis consultas (esta função roda por perícia).
  const rollData = actor.getRollData();
  const nomeados = [
    ...getModificadoresNomeados(actor, "system.modificadores.pericias.geral", rollData),
    ...(ehAtaque ? getModificadoresNomeados(actor, "system.modificadores.pericias.ataque", rollData) : []),
    ...(ehResistencia ? getModificadoresNomeados(actor, "system.modificadores.pericias.resistencia", rollData) : []),
    ...(!ehAtaque ? getModificadoresNomeados(actor, "system.modificadores.pericias.semataque", rollData) : []),
    ...getModificadoresNomeados(actor, `system.modificadores.pericias.atr.${atributoChave}`, rollData),
    ...getModificadoresNomeados(actor, `system.pericias.${chave}.bonus`, rollData),
    // "+1 em todas as perícias" é escrito com `*` (mesmos curingas do
    // atributo); sem esta linha o bônus existia no total e chegava à tela
    // como um "Outros efeitos" sem nome.
    ...getModificadoresNomeados(actor, "system.pericias.*.bonus", rollData)
  ];

  // `actor.getRollData()` inclui "@meionivel" (metade do nível, sempre) em
  // toda fórmula de perícia — confirmado lendo `Actor#getRollData` no
  // código-fonte, é incondicional pra qualquer tipo de ator, não só NPC.
  const meioNivel = Math.floor((getNivel(actor) ?? 0) / 2) || 0;

  // Penalidade de armadura (só nas perícias marcadas `pda` na config) e
  // modificador de tamanho (só nas marcadas `sizeMod`, ex: Furtividade) —
  // caminhos confirmados em `prepareSkill`/`getRollData`.
  const pda = dado.pda ? (actor.system?.attributes?.defesa?.pda ?? 0) : 0;
  const tamanhoChave = actor.system?.tracos?.tamanho;
  const modTamanho = dado.size ? (t20Config().sizeModifiers?.[tamanhoChave] ?? 0) : 0;

  const partes = [
    meioNivel ? { rotulo: "Metade do Nível", valor: meioNivel } : null,
    // Nome completo, não a sigla: o detalhamento é lido devagar, para conferir
    // de onde vem o número — "Inteligência" diz mais que "Int".
    { rotulo: localizeAtributo(atributoChave), valor: atributoMod },
    dado.treinado ? { rotulo: "Treino", valor: treino } : null,
    dado.outros ? { rotulo: "Outros", valor: dado.outros } : null,
    dado.condi ? { rotulo: "Condição", valor: dado.condi } : null,
    pda ? { rotulo: "Penalidade de Armadura", valor: pda } : null,
    modTamanho ? { rotulo: "Tamanho", valor: modTamanho } : null,
    ...nomeados
  ].filter(Boolean);

  const conhecido = partes.reduce((soma, parte) => soma + parte.valor, 0);
  const residual = (dado.value ?? 0) - conhecido;
  if (residual) partes.push({ rotulo: "Outros efeitos", valor: residual });

  return {
    label: cfg?.label ?? dado.label ?? chave,
    total: dado.value ?? 0,
    totalFormatado: formatarBonus(dado.value ?? 0),
    partes: partes.map((p) => ({ ...p, valorFormatado: formatarBonus(p.valor) }))
  };
}

// ---------------------------------------------------------------------------
// Dinheiro
// ---------------------------------------------------------------------------

export function getDinheiro(actor) {
  const dinheiro = actor.system?.dinheiro ?? {};
  return MOEDAS.map((moeda) => ({ ...moeda, valor: dinheiro[moeda.chave] ?? 0 }));
}

/**
 * O dinheiro do personagem somado na unidade base (T$), para quem só precisa
 * do número — a lista de personagens mostra isso ao lado do nível, e somar
 * 1 TO = 10 T$ de cabeça não é papel de quem está escolhendo com quem jogar.
 */
export function getDinheiroEmTibar(actor) {
  return getDinheiro(actor).reduce((soma, moeda) => soma + moeda.valor * moeda.emTibar, 0);
}

export async function ajustarDinheiro(actor, chave, novoValor) {
  const valor = Math.max(0, Number(novoValor) || 0);
  return actor.update({ [`system.dinheiro.${chave}`]: valor });
}

// ---------------------------------------------------------------------------
// Itens: inventário (arma/equipamento/consumivel/tesouro), poderes, magias
// ---------------------------------------------------------------------------

const TIPOS_INVENTARIO = [
  { tipo: "arma", label: "Armas" },
  { tipo: "equipamento", label: "Equipamentos" },
  { tipo: "consumivel", label: "Consumíveis" },
  { tipo: "tesouro", label: "Tesouros" }
];

/**
 * Consumível vira um grupo por tipo, em vez de um monte só: numa mesa, o que
 * se procura é "a poção", "o pergaminho" — não "o consumível". As chaves são
 * as do próprio sistema (o `select` de tipo na ficha de item); os rótulos vão
 * no plural porque aqui são títulos de lista, e a ordem na tela é alfabética
 * (ver `separarConsumiveis`), não a desta lista.
 */
const TIPOS_CONSUMIVEL = [
  { tipo: "ammo", label: "Munições" },
  { tipo: "scroll", label: "Pergaminhos" },
  { tipo: "alchemy", label: "Alquímicos" },
  { tipo: "potion", label: "Poções" },
  { tipo: "material", label: "Materiais" },
  { tipo: "food", label: "Comida" }
];

// Só arma/equipamento têm o campo `equipado` no sistema (WeaponData usa
// número 0-2, EquipmentData usa boolean — ver README/nota histórica).
const TIPOS_EQUIPAVEIS = ["arma", "equipamento"];

/**
 * Descrições vêm do Foundry com referências no formato `@UUID[...]{Visão
 * Mística}` — links que só funcionam dentro do Foundry e que, crus, aparecem
 * como aquele bloco de colchetes no meio da frase. Aqui viram o nome puro,
 * que é o que o jogador precisa ler na mesa.
 *
 * Sem rótulo (`@UUID[...]` sozinho) o nome é perguntado ao próprio Foundry;
 * se ele não souber responder — compêndio não indexado, documento apagado —
 * o texto original fica, porque perder a referência inteira é pior do que
 * mostrá-la feia.
 */
function resolverReferencias(html) {
  if (!html) return "";
  return html
    .replace(/@[A-Za-z]+\[[^\]]+\]\{([^}]*)\}/g, (_bruto, rotulo) => rotulo)
    .replace(/@[A-Za-z]+\[([^\]]+)\]/g, (bruto, alvo) => {
      try {
        return fromUuidSync(alvo)?.name ?? bruto;
      } catch {
        return bruto;
      }
    });
}

/**
 * Ler um pergaminho de uma magia que você **não conhece** pede um teste de
 * Misticismo (CD 25) para identificá-la antes de usar; conhecendo a magia, é
 * só ler. O teste é da mesa — o app não rola nada —, então o que sai daqui é
 * o número que se soma ao d20 e a CD.
 *
 * Isso não está no módulo do sistema (lá todo consumível é `item.roll()` e
 * pronto): é regra de livro, e o app a mostra porque é ela que decide se o
 * jogador pode simplesmente usar o pergaminho.
 */
const CD_IDENTIFICAR_MAGIA = 25;
const PERICIA_DO_PERGAMINHO = "mist";

/** Sem acento e em minúsculas: nome de item é escrito à mão. */
function normalizarNome(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * A magia da ficha que este pergaminho contém — quem a tem, dispensa o teste.
 *
 * Duas pistas, nessa ordem: o `_stats.compendiumSource` que o Foundry grava
 * ao escrever o pergaminho (aponta para a magia de origem, e as magias da
 * ficha carregam o mesmo endereço quando vieram do mesmo compêndio) e, na
 * falta dele, o nome — "Pergaminho de Bola de Fogo" termina com o nome da
 * magia. Termina, não contém: senão "Luz" casaria com "Pergaminho de Luz das
 * Estrelas".
 */
function origemDeCompendio(documento) {
  return documento?._stats?.compendiumSource ?? null;
}

function magiaConhecida(actor, item) {
  const magias = actor.items?.filter?.((i) => i.type === "magia") ?? [];
  if (!magias.length) return null;

  const origem = origemDeCompendio(item);
  if (origem) {
    const porOrigem = magias.find((m) => m.uuid === origem || origemDeCompendio(m) === origem);
    if (porOrigem) return porOrigem;
  }

  const nome = normalizarNome(item.name);
  return magias.find((m) => nome.endsWith(normalizarNome(m.name))) ?? null;
}

/**
 * O teste que o pergaminho exige, ou null quando não exige nada — porque o
 * personagem conhece a magia, ou porque o consumível não é pergaminho (poção
 * e alquímico não pedem teste).
 */
function testeDoPergaminho(actor, item, misticismo) {
  if (item.system?.tipo !== "scroll") return null;
  if (magiaConhecida(actor, item)) return null;
  if (!misticismo) return null;

  return {
    pericia: misticismo.label,
    total: misticismo.total,
    totalFormatado: misticismo.totalFormatado,
    cd: CD_IDENTIFICAR_MAGIA
  };
}

/**
 * O que um consumível faz quando usado — no mesmo formato da magia, porque no
 * sistema é a mesma coisa: `_createScroll` copia a magia inteira para dentro
 * de um item `consumivel` (`tipo: "scroll"`), zerando o custo em PM
 * (`ativacao.custo = 0`), e usar um consumível é `item.roll()` com
 * `consumeSelf`, que tira uma unidade dele. Ver `_createScroll` em
 * sheets/item-sheet.mjs e `_getUsageUpdates` em documents/item.mjs.
 *
 * A CD não é recalculada aqui: o próprio sistema já a resolve em
 * `prepareFinalAttributes` (10 + metade do nível + o atributo que o item
 * aponta + o bônus dele) usando os dados de quem carrega o item — que é
 * exatamente o que a mesa espera de um pergaminho na mochila do personagem.
 *
 * Pergaminho e poção sempre se usam, mesmo sem efeito rolável: um pergaminho
 * de Luz não tem dano nem resistência, e continua sendo um pergaminho que se
 * lê e se gasta. Nos outros tipos é o conteúdo que decide — sem efeito, sem
 * resistência e sem custo não há painel a mostrar: é corda, comida, tocha,
 * que seguem sendo item de mochila e nada mais.
 */
const TIPOS_SEMPRE_USAVEIS = ["scroll", "potion"];

function getUsoDeConsumivel(actor, item, rollData, misticismo) {
  const rolagens = getRolagensDeUso(item, rollData);
  const resistencia = item.system?.resistencia?.txt ?? "";
  const custo = Number(item.system?.ativacao?.custo) || 0;
  const sempreUsavel = TIPOS_SEMPRE_USAVEIS.includes(item.system?.tipo);
  if (!sempreUsavel && !rolagens.length && !resistencia && !custo) return null;

  const cd = Number(item.system?.resistencia?.cd) || 0;

  return {
    custo,
    ativacao: labelAtivacao(item),
    alcance: t20Config().distanceUnits?.[item.system?.alcance] ?? item.system?.alcance ?? "",
    alvo: item.system?.alvo ?? "",
    area: item.system?.area ?? "",
    duracao: textoDuracao(item.system?.duracao),
    resistencia,
    cd: cd > 0 ? cd : null,
    rolagens,
    // O teste de leitura, quando o pergaminho é de uma magia desconhecida.
    teste: testeDoPergaminho(actor, item, misticismo),
    // Usar gasta o próprio item, uma unidade: é o `consumeSelf` do sistema.
    consumo: consumoDeItem(item, 1)
  };
}

function mapearItemInventario(item, contexto = null) {
  return {
    id: item.id,
    nome: item.name,
    img: item.img,
    quantidade: item.system?.qtd ?? 1,
    // Na mochila ou no baú: `carregado` é o campo do sistema que decide se o
    // item está com o personagem (e ocupando espaço) ou guardado em algum
    // lugar. Padrão do schema é estar carregado.
    carregado: item.system?.carregado !== false,
    // O que o item vale e o quanto ocupa, como o sistema guarda: preço em T$
    // (a unidade base) e espaços, os dois podendo ser fracionários — meio
    // espaço é o tamanho de um pergaminho.
    preco: Number(item.system?.preco) || 0,
    espacos: Number(item.system?.espacos) || 0,
    // Só consumível se usa; o resto da mochila é item e ponto.
    uso:
      item.type === "consumivel" && contexto
        ? getUsoDeConsumivel(contexto.actor, item, contexto.rollData, contexto.misticismo)
        : null,
    equipavel: TIPOS_EQUIPAVEIS.includes(item.type),
    equipado: !!item.system?.equipado,
    slot: lerSlot(item),
    // "hand", "body" ou "both": onde este item pode ser posto.
    tipoSlot: item.system?.equipado2?.type ?? "",
    duasMaos: item.system?.empunhadura === "duas",
    descricao: resolverReferencias(item.system?.description?.value)
  };
}

/**
 * Quebra os consumíveis nos grupos de `TIPOS_CONSUMIVEL`. O que não se
 * encaixar em nenhum (tipo em branco, ou um tipo novo que o sistema venha a
 * criar) cai num "Consumíveis" no fim — sumir da mochila seria pior.
 */
function separarConsumiveis(itens, contexto) {
  const grupos = TIPOS_CONSUMIVEL.map(({ tipo, label }) => ({
    tipo: `consumivel-${tipo}`,
    label,
    itens: itens.filter((item) => item.system?.tipo === tipo).map((item) => mapearItemInventario(item, contexto))
  }))
    // Alfabética pelo rótulo: é o que se procura numa lista de títulos, e
    // vale sozinha se um rótulo mudar ou um tipo novo aparecer.
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));

  const conhecidos = new Set(TIPOS_CONSUMIVEL.map((t) => t.tipo));
  // O "resto" fica sempre por último, fora da ordem alfabética: é a caixa de
  // sobras, não um tipo como os outros.
  const resto = itens.filter((item) => !conhecidos.has(item.system?.tipo));
  if (resto.length) {
    grupos.push({
      tipo: "consumivel",
      label: "Consumíveis",
      itens: resto.map((item) => mapearItemInventario(item, contexto))
    });
  }

  return grupos;
}

/**
 * Tipos de consumo que gastam unidades de um item da mochila. `attribute`
 * (um recurso do ator) fica de fora: não é item, e o app não mexe nele. Ver
 * `_getUsageUpdates` em documents/item.mjs do sistema.
 */
const TIPOS_CONSUMO_DE_ITEM = ["ammo", "material"];

/**
 * O item que um uso gasta, na forma que o app precisa: o que baixar, quanto,
 * e quanto ainda existe na mochila. Duas origens, ambas nativas do sistema:
 *
 * - arma e magia declaram `system.consume` — a munição do arco, o material da
 *   magia. `mpMultiplier` faz a quantidade acompanhar o custo em PM do uso,
 *   e vem como `porPM` porque só o app sabe o custo final (com os
 *   aprimoramentos marcados na hora);
 * - um aprimoramento que veio de um consumível gasta o próprio consumível ao
 *   ser marcado, como o `consumeSelf` do sistema ao usar a poção.
 */
function consumoDeItem(item, quantidade, porPM = false) {
  if (!item || quantidade <= 0) return null;
  // Guardado no baú conta como zero: o item existe, mas não está à mão para
  // ser gasto num ataque, numa conjuração ou num teste. Quem lê isso já sabe
  // esconder o aprimoramento (disponível zero some da lista) e travar o botão
  // quando é a munição que a arma exige.
  const naMochila = item.system?.carregado !== false;
  return {
    itemId: item.id,
    nome: item.name,
    quantidade,
    porPM,
    disponivel: naMochila ? Number(item.system?.qtd ?? 0) || 0 : 0
  };
}

/** O consumo escrito no próprio item usado (`system.consume`). */
function consumoDeclarado(actor, item) {
  const consume = item.system?.consume ?? {};
  if (!TIPOS_CONSUMO_DE_ITEM.includes(consume.type) || !consume.target) return null;
  return consumoDeItem(actor.items?.get?.(consume.target), Number(consume.amount) || 0, !!consume.mpMultiplier);
}

/** Ordem alfabética pelo nome; `pt-BR` para acento não jogar o item pro fim da lista. */
const porNome = (a, b) => a.nome.localeCompare(b.nome, "pt-BR");

/** O que conta espaço na mochila, como `prepareEncumbrance` lista. */
const TIPOS_QUE_OCUPAM_ESPACO = ["arma", "equipamento", "consumivel", "tesouro"];

/**
 * Espaços ocupados e o limite de carga.
 *
 * O sistema já calcula isso em `prepareEncumbrance`
 * (`dataModel/actor/templates/attributes.mjs`): o ocupado é a soma de
 * `quantidade × espaços` do que está carregado, o limite é `base (10) +
 * Força ×2` e o máximo é o dobro do limite — passou do limite, o personagem
 * está sobrecarregado.
 *
 * Só que ele só faz essa conta quando a opção "carryWeight" do mundo está
 * ligada; desligada, os campos ficam zerados. A barra do app não deveria
 * depender de uma configuração de mesa, então a conta é refeita aqui pela
 * mesma fórmula — inclusive a flag `inventarioOrganizado`, que faz o que
 * ocupa meio espaço passar a ocupar um quarto.
 */
export function getCarga(actor) {
  const carga = actor.system?.attributes?.carga ?? {};
  const limiteDoSistema = Number(carga.limit) || 0;
  if (limiteDoSistema > 0) {
    return {
      atual: Number(carga.value) || 0,
      limite: limiteDoSistema,
      max: Number(carga.max) || limiteDoSistema * 2
    };
  }

  const organizado = !!actor.flags?.tormenta20?.inventarioOrganizado;
  const atual = (actor.items ?? []).reduce((soma, item) => {
    if (!TIPOS_QUE_OCUPAM_ESPACO.includes(item.type)) return soma;
    if (!item.system?.carregado || item.system?.container) return soma;
    const espacos = Number(item.system?.espacos) || 0;
    const unitario = organizado && espacos === 0.5 ? 0.25 : espacos;
    return soma + (Number(item.system?.qtd) || 0) * unitario;
  }, 0);

  const atributo = Number(actor.system?.atributos?.[carga.atributo || "for"]?.value) || 0;
  const base = Number(carga.base) || 10;
  // Força negativa tira um espaço por ponto, não dois — é assim no sistema.
  const limite = base + (atributo > 0 ? atributo * 2 : atributo);
  return { atual, limite, max: limite * 2 };
}

export function getInventario(actor) {
  // Uma vez só: as fórmulas dos consumíveis resolvem com os dados de quem
  // carrega o item, como as da magia. A de Misticismo é cara (varre os
  // modificadores da ficha) e só interessa a pergaminho, então nem é montada
  // quando não há nenhum.
  const temPergaminho = actor.items.some((i) => i.type === "consumivel" && i.system?.tipo === "scroll");
  const contexto = {
    actor,
    rollData: actor.getRollData(),
    misticismo: temPergaminho ? getFormulaPericia(actor, PERICIA_DO_PERGAMINHO) : null
  };

  return TIPOS_INVENTARIO.flatMap(({ tipo, label }) => {
    const itens = actor.items.filter((i) => i.type === tipo);
    if (tipo === "consumivel") return separarConsumiveis(itens, contexto);
    return [{ tipo, label, itens: itens.map((item) => mapearItemInventario(item)) }];
  })
    .filter((grupo) => grupo.itens.length)
    // Num ponto só, depois de os grupos estarem montados: a ordem dentro da
    // lista não depende de qual caminho montou o grupo, e `game.actors` não
    // garante ordem nenhuma.
    .map((grupo) => ({ ...grupo, itens: grupo.itens.sort(porNome) }));
}

/**
 * Liga/desliga a preparação de uma magia. Só faz sentido para quem prepara
 * (flag `mago`) e nunca para engenhoca — as mesmas condições que decidem se o
 * controle aparece na tela. Revalidadas aqui porque o front não é autoridade:
 * a mensagem chega pela rede e pode vir de uma tela desatualizada.
 */
export async function alternarPreparada(actor, magiaId) {
  const magia = actor.items.get(magiaId);
  if (magia?.type !== "magia") return;
  if (!actor.flags?.tormenta20?.mago || magia.system?.tipo === "eng") return;
  return magia.update({ "system.preparada": !magia.system?.preparada });
}

/**
 * Soma (ou subtrai) unidades de um item da mochila — o contador do
 * inventário. Piso em zero, e o item nunca sai da ficha: ver `gastarUso`.
 */
export async function ajustarQuantidade(actor, itemId, delta) {
  const item = actor.items.get(itemId);
  if (!item) throw new Error("Este item não está mais na ficha.");
  const atual = Number(item.system?.qtd ?? 0) || 0;
  const novo = Math.max(0, atual + (Math.floor(Number(delta)) || 0));
  if (novo === atual) return;
  return item.update({ "system.qtd": novo });
}

/**
 * Passa o item da mochila para o baú e de volta. Além de tirá-lo da conta de
 * espaços (o efeito que o sistema dá a `carregado`), guardar **desequipa**: o
 * que está no fundo do baú não está na mão nem no corpo, e deixar a armadura
 * marcada como vestida enquanto guardada somaria Defesa que não existe. O
 * slot também é zerado, que é como o sistema representa "nenhum".
 *
 * Tirar do baú não reequipa: voltar a empunhar é uma decisão da mesa.
 */
export async function alternarCarregado(actor, itemId) {
  const item = actor.items.get(itemId);
  if (!item) throw new Error("Este item não está mais na ficha.");

  const guardando = item.system?.carregado !== false;
  if (!guardando) return item.update({ "system.carregado": true });

  return item.update({
    "system.carregado": false,
    "system.equipado": false,
    "system.equipado2.slot": 0
  });
}

export async function alternarEquipado(actor, itemId) {
  const item = actor.items.get(itemId);
  if (!item) return;
  return item.update({ "system.equipado": !item.system?.equipado });
}

function labelAtivacao(item) {
  const execucao = item.system?.ativacao?.execucao;
  return t20Config().abilityActivationTypes?.[execucao] ?? execucao ?? "";
}

/**
 * Tag que marca um poder como ativável (`system.rolltags`, o mesmo campo das
 * tags `lvl-NN`). Quem decide é o mestre, escrevendo `ativo` no poder: uma
 * heurística nossa — "tem execução declarada", "cobra PM" — erraria nos dois
 * sentidos, porque no compêndio há passiva com execução preenchida e poder
 * de usar que não cobra nada.
 */
const TAG_ATIVO = "ativo";

/**
 * As tags do item são `Set` desde o T20 1.6 — `Set` não tem `.some` nem
 * `.filter`, só iteração, então tudo que as percorre passa por aqui.
 */
function tagsDeRolagem(item) {
  return [...(item.system?.rolltags ?? [])];
}

function ehAtivavel(item) {
  return tagsDeRolagem(item).some((tag) => String(tag).trim().toLowerCase() === TAG_ATIVO);
}

/**
 * Nível em que o poder foi ganho, lido da tag `lvl-06` que o mestre põe no
 * poder (`system.rolltags`). Sem tag, é poder de base — o que veio de raça,
 * origem ou divindade, e não de subir de nível.
 */
function nivelDoPoder(item) {
  for (const tag of tagsDeRolagem(item)) {
    const achado = /^lvl-(\d+)$/i.exec(String(tag).trim());
    if (achado) return Number(achado[1]);
  }
  return 0;
}

/**
 * Ordem dos tipos dentro do grupo Base. Tipo que não esteja aqui (poder de
 * classe solto, distinção, complicação) entra junto do "geral", no fim —
 * misturado a ele na ordem alfabética, em vez de abrir um bloco só seu.
 */
const ORDEM_TIPO_BASE = ["racial", "concedido", "origem", "geral"];

function ordemNoBase(tipo) {
  const indice = ORDEM_TIPO_BASE.indexOf(tipo);
  return indice === -1 ? ORDEM_TIPO_BASE.length - 1 : indice;
}

export function getPoderes(actor) {
  const powerType = t20Config().powerType ?? {};
  const distancias = t20Config().distanceUnits ?? {};
  const rollData = actor.getRollData();

  return actor.items
    .filter((i) => i.type === "poder")
    .map((item) => ({ item, nivel: nivelDoPoder(item), tipoChave: item.system?.tipo ?? "" }))
    .sort((a, b) => {
      if (a.nivel !== b.nivel) return a.nivel - b.nivel;
      // No Base manda o tipo do poder; nos níveis, o que abre o grupo é a
      // habilidade de classe (o poder que a classe dá de graça naquele nível),
      // e o resto vem depois.
      const ordem =
        a.nivel === 0
          ? ordemNoBase(a.tipoChave) - ordemNoBase(b.tipoChave)
          : (a.tipoChave === "ability" ? 0 : 1) - (b.tipoChave === "ability" ? 0 : 1);
      return ordem || a.item.name.localeCompare(b.item.name, "pt-BR");
    })
    .map(({ item, nivel }) => {
      const ativavel = ehAtivavel(item);
      const custo = Number(item.system?.ativacao?.custo) || 0;
      // A CD sai pronta do item: o sistema a calcula em
      // `prepareFinalAttributes` (10 + metade do nível + atributo + bônus),
      // e só quando o poder declara resistência.
      const cd = Number(item.system?.resistencia?.cd);

      return {
        id: item.id,
        nome: item.name,
        img: item.img,
        tipo: powerType[item.system?.tipo] ?? item.system?.tipo ?? "",
        subtipo: item.system?.subtipo ?? "",
        ativacao: labelAtivacao(item),
        descricao: resolverReferencias(item.system?.description?.value),
        nivel,
        /** Título da seção na tela — o front só agrupa o que já vem em ordem. */
        grupo: nivel === 0 ? "Base" : `Nível ${nivel}`,
        /**
         * Há o que ativar: o mestre marcou o poder com a tag `ativo`. Sem
         * ela o poder é passiva na tela — o bônus dele já está na ficha, e um
         * botão "Ativar" não faria nada.
         */
        ativavel,
        // Daqui pra baixo é o que a tela de ativar precisa. São os mesmos
        // campos da magia porque no sistema é o mesmo molde: `PowerData` e
        // `SpellData` montam ambos `schemaActivation` + `schemaSavingThrow` +
        // `schemaRolls`. Só para quem é ativável: montar as rolagens de cada
        // passiva sairia caro numa ficha com trinta poderes, e a tela nem as
        // usaria.
        custo,
        alcance: distancias[item.system?.alcance] ?? item.system?.alcance ?? "",
        alvo: item.system?.alvo ?? "",
        area: item.system?.area ?? "",
        duracao: textoDuracao(item.system?.duracao),
        resistencia: item.system?.resistencia?.txt ?? "",
        cd: Number.isFinite(cd) && cd > 0 ? cd : null,
        rolagens: ativavel ? getRolagensDeUso(item, rollData) : [],
        consumo: ativavel ? consumoDeclarado(actor, item) : null,
        /** O que o poder liga na ficha ao ser ativado (Fúria, Frenesi...). */
        efeitos: ativavel ? getEfeitosDeAtivacao(actor, item) : []
      };
    });
}

/**
 * O que a magia faz com os pontos, por chave do sistema. Magia não causa
 * "dano de corte": ela cura, drena ou queima — e a maioria mexe em PV/PM, não
 * em tipo de dano nenhum.
 */
const EFEITO_DA_MAGIA = {
  curapv: "Cura",
  curatpv: "PV temporários",
  curapm: "PM recuperados",
  curatpm: "PM temporários",
  perda: "Perda de PV"
};

/**
 * Rolagens de uma magia. Mesma origem que as da arma (`system.rolls`), mas
 * lidas com outra cabeça: aqui não existe "dano da arma" nem atributo somado
 * por empunhadura — o que há é a fórmula da magia e o que ela faz com ela.
 */
/**
 * Rolagens de efeito de um uso. Vale para magia, pergaminho e poder: no
 * sistema os três compartilham o mesmo `schemaRolls` (ver `PowerData` e
 * `SpellData`, ambos montados sobre `Tormenta20ItemData`).
 */
function getRolagensDeUso(item, rollData) {
  return (item.system?.rolls ?? [])
    .filter((rolagem) => rolagem.type === "dano")
    .map((rolagem) => {
      const dados = [];
      const itens = [];
      let fixo = 0;
      let efeito = "";

      for (const [formula, tipo] of rolagem.parts ?? []) {
        if (!formula) continue;
        const texto = String(formula);
        efeito = efeito || EFEITO_DA_MAGIA[tipo] || t20Config().damageTypes?.[tipo] || "";

        if (/d\d/i.test(texto)) {
          dados.push(texto);
          itens.push({ rotulo: rolagem.name || "Base", valor: 0, dado: texto });
          continue;
        }
        const valor = avaliarFormula(texto, rollData);
        if (valor !== null) {
          fixo += valor;
          itens.push({ rotulo: rotuloDaParteDeDano(texto), valor });
        }
      }

      const partes = [...dados];
      if (fixo) partes.push(formatarBonus(fixo).replace("+", "+ "));

      return {
        nome: rolagem.name || efeito || "Efeito",
        formula: partes.join(" ").trim() || "—",
        efeito,
        fixo,
        itens
      };
    });
}

/**
 * CD das magias do personagem, montada como a ficha do sistema monta (ver
 * `list-spells.hbs`): `attributes.cd` — que o sistema já deixa pronto com
 * 10 + metade do nível — mais o modificador do atributo de conjuração, que é
 * escolhido na ficha e pode ter sido trocado por um poder.
 */
function getCdDeMagia(actor) {
  const attributes = actor.system?.attributes ?? {};
  const base = Number(attributes.cd);
  if (!Number.isFinite(base)) return null;

  const chave = attributes.conjuracao;
  const atributo = chave ? Number(actor.system?.atributos?.[chave]?.value) || 0 : 0;
  return base + atributo;
}

/** "Instantânea", "Cena", "3 rodadas" — o que a ficha do sistema mostra em Duração. */
function textoDuracao(duracao) {
  const unidade = t20Config().timePeriods?.[duracao?.units] ?? duracao?.units ?? "";
  const valor = Number(duracao?.value) || 0;
  if (duracao?.special) return duracao.special;
  return valor > 0 ? `${valor} ${unidade}`.trim() : unidade;
}

export function getMagias(actor) {
  const spellSchools = t20Config().spellSchools ?? {};
  const spellType = t20Config().spellType ?? {};
  const distancias = t20Config().distanceUnits ?? {};
  const rollData = actor.getRollData();
  // Uma vez só: a CD é do conjurador, igual para todas as magias dele.
  const cd = getCdDeMagia(actor);
  // Só quem prepara magias tem "preparada" — a flag `mago` é a mesma que a
  // ficha do sistema consulta (lá se chama `isPreparationCaster`). Druida,
  // bardo e afins conjuram espontaneamente: para eles o conceito não existe.
  const preparaMagias = !!actor.flags?.tormenta20?.mago;

  return actor.items
    .filter((i) => i.type === "magia")
    .map((item) => ({
      id: item.id,
      nome: item.name,
      img: item.img,
      circulo: item.system?.circulo ?? 0,
      escola: spellSchools[item.system?.escola] ?? item.system?.escola ?? "",
      tipo: spellType[item.system?.tipo] ?? item.system?.tipo ?? "",
      preparada: !!item.system?.preparada,
      // Engenhoca não se prepara nem para quem prepara — mesma exceção que a
      // ficha do sistema faz (`ne m.system.tipo 'eng'`).
      preparavel: preparaMagias && item.system?.tipo !== "eng",
      ativacao: labelAtivacao(item),
      descricao: resolverReferencias(item.system?.description?.value),
      // Daqui pra baixo é o que a tela de conjurar precisa.
      custo: Number(item.system?.ativacao?.custo) || 0,
      alcance: distancias[item.system?.alcance] ?? item.system?.alcance ?? "",
      alvo: item.system?.alvo ?? "",
      area: item.system?.area ?? "",
      duracao: textoDuracao(item.system?.duracao),
      // O texto da resistência ("Vontade anula") vem escrito na magia; a CD
      // é do conjurador, não dela — por isso sai de `attributes`.
      resistencia: item.system?.resistencia?.txt ?? "",
      cd,
      rolagens: getRolagensDeUso(item, rollData),
      consumo: consumoDeclarado(actor, item)
    }))
    .sort((a, b) => a.circulo - b.circulo || a.nome.localeCompare(b.nome, "pt-BR"));
}

// ---------------------------------------------------------------------------
// Ações — delegam para os métodos do próprio sistema (evita duplicar a
// lógica de clamp/PV-temporário/PM-temporário que o sistema já resolve)
// ---------------------------------------------------------------------------

/**
 * `applyDamage` do sistema trava o PV em `pv.min`, que é 0 nas fichas — e em
 * T20 o PV negativo importa: é o que separa "caído" de "morrendo". Quando o
 * resultado passa desse piso, escrevemos o campo direto, replicando o que o
 * sistema faria com os PV temporários (o dano sai deles primeiro). Nos demais
 * casos segue pelo método do sistema, que dispara os hooks e o card de dano.
 */
export async function gastarPV(actor, quantidade) {
  if (typeof actor.applyDamage !== "function") {
    throw new Error(`actor.applyDamage não existe em "${actor.name}"`);
  }

  const pv = actor.system?.attributes?.pv ?? {};
  const temp = Number(pv.temp) || 0;
  const dano = Math.abs(quantidade);
  const doTemporario = Math.min(temp, dano);
  const alvo = (Number(pv.value) || 0) - (dano - doTemporario);

  if (alvo < (Number(pv.min) || 0)) {
    return actor.update({
      "system.attributes.pv.temp": temp - doTemporario,
      "system.attributes.pv.value": alvo
    });
  }

  return actor.applyDamage(dano, 1, false);
}

export async function curarPV(actor, quantidade) {
  if (typeof actor.applyDamage !== "function") {
    throw new Error(`actor.applyDamage não existe em "${actor.name}"`);
  }
  return actor.applyDamage(-Math.abs(quantidade), 1, false);
}

export async function gastarPM(actor, quantidade) {
  if (typeof actor.spendMana !== "function") {
    throw new Error(`actor.spendMana não existe em "${actor.name}"`);
  }
  return actor.spendMana(Math.abs(quantidade), 0, false);
}

export async function recuperarPM(actor, quantidade) {
  if (typeof actor.spendMana !== "function") {
    throw new Error(`actor.spendMana não existe em "${actor.name}"`);
  }
  return actor.spendMana(Math.abs(quantidade), 0, true);
}

/** Define o valor atual de PV/PM diretamente (usado pelo modal de recurso, que edita o campo "Atual" livremente). */
export async function definirAtual(actor, recurso, novoValor) {
  const dados = actor.system?.attributes?.[recurso] ?? {};
  const atual = dados.value ?? 0;

  // PM nunca fica negativo (o próprio spendMana trava em 0); PV pode.
  const alvo = recurso === "pm" ? Math.max(0, novoValor) : novoValor;

  // Sair de um PV negativo para outro valor negativo é uma escrita direta:
  // curarPV passa por applyDamage, que traria o valor de volta para o piso.
  if (recurso === "pv" && alvo < (Number(dados.min) || 0)) {
    return actor.update({ "system.attributes.pv.value": alvo });
  }

  const delta = alvo - atual;
  if (!delta) return;
  if (recurso === "pv") {
    if (delta > 0) return curarPV(actor, delta);
    return gastarPV(actor, Math.abs(delta));
  }
  if (delta > 0) return recuperarPM(actor, delta);
  return gastarPM(actor, Math.abs(delta));
}

export async function definirTemporario(actor, recurso, novoValor) {
  const valor = Math.max(0, Number(novoValor) || 0);
  return actor.update({ [`system.attributes.${recurso}.temp`]: valor });
}

/**
 * Descanso: cura PV e PM até o máximo (mais o extra por nível informado pelo
 * jogador, se houver). O sistema `tormenta20` não expõe uma regra de
 * descanso própria para o módulo delegar — a qualidade/cuidados médicos da
 * tela são mantidos como estão no design, mas hoje só o campo "extra por
 * nível" tem efeito de fato. Ver docs/impedimentos.md.
 */
/**
 * Multiplicador de recuperação por nível de cada condição de descanso
 * (Tormenta 20, p. 106). Os mesmos valores da macro "Descanso" que acompanha
 * o sistema.
 */
const CONDICOES_DESCANSO = { ruim: 0.5, normal: 1, confortavel: 2, luxuoso: 3 };

/**
 * Descanso pelas regras do sistema — `actor.descanso` já existe no tormenta20
 * e é o que a macro oficial chama, então a conta e o card de chat são dele.
 *
 *   PV = piso(nível × (modificador + modPV))
 *   PM = piso(nível × (modificador + modPM))
 *
 * Cuidados Prolongados e Acompanhamento Médico entram como +1 PV por nível
 * cada, somados em `modPV`. Isso é de propósito: `actor.descanso` aceita dois
 * sinalizadores próprios para eles, mas o que faz é *dobrar* o total (PV no
 * primeiro, PM no segundo), e a regra é somar +1 por nível aos PV — como diz
 * a própria descrição da perícia Cura no compêndio do sistema ("aumenta sua
 * recuperação de PV em +1 por nível nesse dia"). Os sinalizadores vão sempre
 * como `false`; o bônus é expresso onde ele de fato pertence.
 */
export async function descansar(actor, opcoes = {}) {
  if (typeof actor.descanso !== "function") {
    throw new Error(`actor.descanso não existe em "${actor.name}" — sistema tormenta20 desatualizado?`);
  }

  const {
    condicao = "normal",
    pvExtraPorNivel = 0,
    pmExtraPorNivel = 0,
    cuidadosProlongados = false,
    acompanhamentoMedico = false
  } = opcoes;

  const bonusDeCura = (cuidadosProlongados ? 1 : 0) + (acompanhamentoMedico ? 1 : 0);

  return actor.descanso(
    CONDICOES_DESCANSO[condicao] ?? CONDICOES_DESCANSO.normal,
    (Number(pvExtraPorNivel) || 0) + bonusDeCura,
    Number(pmExtraPorNivel) || 0,
    false,
    false,
    true
  );
}



/** Texto vindo do app nunca entra cru no chat da mesa. */
function escaparHtml(texto) {
  const mapa = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(texto ?? "").replace(/[&<>"']/g, (caractere) => mapa[caractere]);
}

/**
 * O aviso de gasto no chat da mesa. Sai em nome do jogador que apertou o
 * botão — o relay roda no client do mestre, então `author` precisa ser dito,
 * senão a mensagem apareceria como fala do mestre — e falando pelo
 * personagem. Público, como uma rolagem: gasto de PM e de item é informação
 * de mesa, não bastidor.
 */
/** "3 PM e Flecha ×2" — o que saiu da ficha, em texto. Vazio quando não saiu nada. */
function textoDoGasto(pm, gastos) {
  const partes = [];
  if (pm > 0) partes.push(`<strong>${pm} PM</strong>`);
  for (const { item, quantidade } of gastos) {
    partes.push(`<strong>${escaparHtml(item.name)}</strong>${quantidade > 1 ? ` ×${quantidade}` : ""}`);
  }
  if (!partes.length) return "";
  return partes.length > 1 ? `${partes.slice(0, -1).join(", ")} e ${partes.at(-1)}` : partes[0];
}

async function anunciarGasto(actor, user, acao, pm, gastos) {
  const lista = textoDoGasto(pm, gastos);
  if (!lista) return;

  // Usar um pergaminho é o caso em que a ação e o gasto são o mesmo objeto —
  // "Pergaminho de Bola de Fogo — gastou Pergaminho de Bola de Fogo" seria
  // gaguejar. Aí a frase é uma só: usou aquilo.
  const ehOProprioItem = !pm && gastos.length === 1 && gastos[0].item.name === acao;
  const titulo = acao && !ehOProprioItem ? `<strong>${escaparHtml(acao)}</strong> — ` : "";
  const verbo = ehOProprioItem ? "usou" : "gastou";

  return ChatMessage.implementation.create({
    author: user?.id ?? game.user.id,
    speaker: ChatMessage.implementation.getSpeaker({ actor }),
    content: `<p>${titulo}${verbo} ${lista}.</p>`
  });
}

/**
 * Nomes dos aprimoramentos marcados, resolvidos aqui a partir dos ids que o
 * app mandou — mesmo princípio do resto: o app manda id, o Foundry resolve o
 * texto. Varre os efeitos uma vez por ativação, o que é barato para algo que
 * nasce de um toque humano.
 */
function nomesDeAprimoramentos(actor, ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const porId = new Map(getAprimoramentos(actor).map((a) => [a.id, a.nome]));
  return ids.map((id) => porId.get(id)).filter(Boolean);
}


// ---------------------------------------------------------------------------
// Efeitos da ficha
// ---------------------------------------------------------------------------

/**
 * Onde o Foundry v14 e o T20 1.6 puseram as partes de um Active Effect, num
 * lugar só — o resto do arquivo pergunta aqui em vez de repetir os caminhos.
 *
 * As mudanças desceram de `effect.changes` para `effect.system.changes`, e o
 * que o sistema guardava em `flags.tormenta20` (efeito "de uso", custo em PM,
 * escopos, nomes de item) virou campo de `effect.system`.
 */
function mudancasDoEfeito(efeito) {
  return efeito?.system?.changes ?? [];
}

/**
 * Efeito "de uso": a opção que se marca ao conjurar ou ativar algo, não um
 * bônus que está ligado na ficha.
 */
function ehEfeitoDeUso(efeito) {
  return !!efeito?.system?.onuse;
}

/** A configuração de uso de um efeito: custo, escopos, restrição por nome. */
function dadosDeUso(efeito) {
  return efeito?.system?.abilityUse ?? {};
}

/**
 * O nome do campo segundo o **próprio sistema**: cada campo do schema de
 * personagem declara um `label`, e é dele que sai "Bônus de Defesa por Efeitos
 * Aplicados" para `system.modificadores.defesa`. Perguntar ao schema cobre os
 * caminhos todos de uma vez — inclusive os que ainda nem existiam quando isto
 * foi escrito — em vez de uma tabela nossa correndo atrás do sistema.
 */
function rotuloPeloSchema(actor, caminho) {
  try {
    const label = actor.system?.schema?.getField?.(caminho)?.label ?? "";
    if (!label) return "";
    // O Foundry troca os labels do schema pelo texto traduzido no `i18nInit`;
    // se ainda vier a chave ("T20.Algo"), tentamos traduzir na mão.
    if (!label.startsWith("T20.")) return label;
    const traduzido = game.i18n?.localize(label) ?? "";
    return traduzido && traduzido !== label ? traduzido : "";
  } catch {
    return "";
  }
}

/**
 * O que cada chave de Active Effect mexe, em português.
 *
 * Atributo e perícia vêm primeiro porque o nome deles ("Força", "Luta") diz
 * mais do que o label genérico do schema. Depois o schema responde por todo o
 * resto, e só o que ninguém souber nomear sai com a chave crua — feia, mas
 * honesta: melhor do que inventar um rótulo errado. O app ainda reescreve o
 * que quiser em `lib/nomes-de-efeitos.ts`, sem passar por aqui.
 */
function rotuloDaMudanca(actor, chave) {
  const texto = String(chave ?? "");

  const atributo = /^system\.atributos\.(\w+)\./.exec(texto);
  if (atributo) return localizeAtributo(atributo[1]);

  const pericia = /^system\.pericias\.(\w+)\./.exec(texto);
  if (pericia) return t20Config().pericias?.[pericia[1]]?.label ?? pericia[1];

  // Resistência a dano é combinação, não caminho fixo: treze tipos de dano
  // vezes cinco partes. Listar as sessenta e cinco numa tabela envelheceria no
  // primeiro tipo de dano novo — aqui o nome sai do `damageTypes` do sistema.
  // (`tracos` é a grafia que o editor de efeitos usa; `traits`, a do schema.)
  const resistencia = /^system\.(?:tracos|traits)\.resistencias\.(\w+)\.(\w+)$/.exec(texto);
  if (resistencia) {
    const [, tipo, parte] = resistencia;
    const nome = (t20Config().damageTypes?.[tipo] ?? tipo).toLocaleLowerCase("pt-BR");
    switch (parte) {
      case "bonus":
      case "value":
        return `Resistência a ${nome}`;
      case "vulnerabilidade":
        return `Vulnerabilidade a ${nome}`;
      case "imunidade":
        return `Imunidade a ${nome}`;
      case "danoPorDado":
        return `Dano por dado de ${nome}`;
      case "excecao":
        return `Exceção da resistência a ${nome}`;
      default:
        return `Resistência a ${nome}`;
    }
  }

  const conhecidos = {
    "system.attributes.pv.max": "PV máximo",
    "system.attributes.pm.max": "PM máximo",
    "system.attributes.defesa.value": "Defesa",
    "system.attributes.defesa.outros": "Defesa",
    "system.attributes.desloc.value": "Deslocamento",
    "system.attributes.desloc.outros": "Deslocamento",
    "system.attributes.cd": "CD",
    "system.attributes.rd": "Redução de dano",
    "system.modificadores.custoPM": "Custo em PM"
  };
  if (conhecidos[texto]) return conhecidos[texto];

  return rotuloPeloSchema(actor, texto.replace(/^system\./, "")) || texto;
}

/**
 * O valor da mudança já resolvido. Um efeito guarda a fórmula que o mestre
 * escreveu — `floor((@nvl.barbaro+1)/4)+1` no Instinto Selvagem —, e é o
 * número dela que interessa a quem está na mesa.
 *
 * Fica cru em dois casos: quando é uma rolagem ("1d6"), que só o dado resolve,
 * e quando alguma referência não existe na ficha. Neste segundo caso a
 * substituição sai sem o `missing: "0"` que o resto do adaptador usa, de
 * propósito: com ele uma referência desconhecida viraria zero e o app
 * mostraria um número errado com cara de certo — melhor devolver a fórmula e
 * deixar claro que ninguém a resolveu.
 */
function valorDaMudanca(valorBruto, rollData) {
  const texto = String(valorBruto ?? "").trim();
  if (!texto) return "";
  if (Number.isFinite(Number(texto))) return texto;
  if (/d\d/i.test(texto)) return texto;

  try {
    const resolvido = Roll.safeEval(Roll.replaceFormulaData(texto, rollData));
    return Number.isFinite(resolvido) ? String(resolvido) : texto;
  } catch {
    return texto;
  }
}

/**
 * Como o Active Effect aplica o valor — o `type` do Foundry v14, em uma
 * palavra. "downgrade" e "upgrade" são teto e piso, nessa ordem: o primeiro
 * só baixa o valor, o segundo só o levanta (a versão anterior deste módulo
 * lia os dois trocados, herdando a inversão dos códigos 3 e 4).
 */
const PALAVRA_DO_TIPO = {
  multiply: "multiplica",
  downgrade: "no máximo",
  upgrade: "no mínimo",
  override: "vira",
  subtract: "subtrai"
};

function modoDaMudanca(tipo) {
  // "add" e "custom" caem no padrão: somar é o caso comum, e um custom do
  // sistema também acaba somando na prática.
  return PALAVRA_DO_TIPO[String(tipo ?? "")] ?? "soma";
}

/**
 * Duração em texto. O Foundry já monta esse rótulo ("3 rodadas", "1 minuto") e
 * desconta o que passou — reaproveitar é o que faz o app mostrar o mesmo que o
 * mestre vê na ficha.
 *
 * Quem decide se há prazo é o `isTemporary` do próprio efeito, não o rótulo:
 * sem duração o Foundry devolve um texto traduzido ("Nenhum" em português), e
 * um efeito permanente ganhava uma etiqueta "Nenhum" na tela. No v14 um
 * efeito também pode ter prazo sem contagem — acaba num **evento** (o fim da
 * cena, o conjurador parar de sustentar) —, e aí o nome do evento é o que há
 * para mostrar.
 */
function textoDaDuracao(efeito) {
  if (!efeito.isTemporary) return "";
  const duracao = efeito.duration ?? {};
  if (Number(duracao.value) > 0 && duracao.label) return duracao.label;

  const evento = duracao.expiry ? CONFIG?.ActiveEffect?.expiryEvents?.[duracao.expiry] : "";
  return evento ? t20Localize(evento, evento) : (duracao.label ?? "");
}

/**
 * Tira um efeito da ficha. Só o que **mora** no ator: um efeito que vem de um
 * item (a armadura, o poder passivo) não é dele para apagar — sairia do item
 * de todo mundo, e some sozinho quando o item sai ou é desequipado.
 */
export async function removerEfeito(actor, efeitoId) {
  const efeito = actor.effects?.get?.(efeitoId);
  if (!efeito) {
    throw new Error("Este efeito não está na ficha — ele vem de um item, e sai junto com ele.");
  }
  await efeito.delete();
}

/**
 * Ordem dos grupos na lista. O que tem prazo primeiro — é o que muda dentro da
 * sessão e o que o jogador precisa lembrar que vai acabar. Depois o
 * permanente, que é pano de fundo. Por último o que não está contando agora.
 */
const ORDEM_DOS_EFEITOS = { temporario: 0, passivo: 1, inativo: 2 };

function tipoDoEfeito(ativo, duracao) {
  if (!ativo) return "inativo";
  return duracao ? "temporario" : "passivo";
}

/**
 * A ficha técnica do item de origem, na linguagem do tipo dele: um poder se
 * descreve por tipo e nível, uma magia por círculo e escola, um equipamento
 * por preço e espaços. É o mesmo recorte que as telas de Poderes, Magias e
 * Inventário mostram — aqui reunido porque a origem de um efeito pode ser
 * qualquer um dos três, e o jogador chegou nela sem passar por aquelas telas.
 */
function dadosDaOrigem(item) {
  const cfg = t20Config();
  const sistema = item.system ?? {};
  const linhas = [];
  const por = (rotulo, valor) => {
    const texto = valor === 0 ? "0" : String(valor ?? "").trim();
    if (texto) linhas.push({ rotulo, valor: texto });
  };
  const custo = Number(sistema.ativacao?.custo) || 0;
  const preco = Number(sistema.preco) || 0;
  const espacos = Number(sistema.espacos) || 0;

  switch (item.type) {
    case "poder": {
      por("Tipo", cfg.powerType?.[sistema.tipo] ?? sistema.tipo);
      por("Subtipo", sistema.subtipo);
      const nivel = nivelDoPoder(item);
      por("Ganho em", nivel ? `Nível ${nivel}` : "Base");
      por("Execução", labelAtivacao(item));
      if (custo > 0) por("Custo", `${custo} PM`);
      break;
    }
    case "magia": {
      por("Círculo", sistema.circulo ? `${sistema.circulo}º` : "");
      por("Escola", cfg.spellSchools?.[sistema.escola] ?? sistema.escola);
      por("Tipo", cfg.spellType?.[sistema.tipo] ?? sistema.tipo);
      por("Execução", labelAtivacao(item));
      if (custo > 0) por("Custo", `${custo} PM`);
      por("Alcance", cfg.distanceUnits?.[sistema.alcance] ?? sistema.alcance);
      por(sistema.area ? "Área" : "Alvo", sistema.area || sistema.alvo);
      por("Duração", textoDuracao(sistema.duracao));
      por("Resistência", sistema.resistencia?.txt);
      break;
    }
    case "arma": {
      const dano = sistema.rolls?.find((rolagem) => rolagem.type === "dano")?.parts?.[0]?.[0];
      por("Dano", dano);
      if (sistema.criticoM || sistema.criticoX) {
        por("Crítico", `${sistema.criticoM ?? 20}/x${sistema.criticoX ?? 2}`);
      }
      por("Alcance", cfg.distanceUnits?.[sistema.alcance] ?? sistema.alcance);
      if (preco) por("Preço", `${preco} T$`);
      if (espacos) por("Espaços", espacos);
      break;
    }
    case "equipamento":
    case "consumivel": {
      por("Tipo", cfg.equipmentTypes?.[sistema.tipo] ?? cfg.consumableTypes?.[sistema.tipo] ?? sistema.tipo);
      if (Number(sistema.qtd) > 1) por("Quantidade", sistema.qtd);
      if (preco) por("Preço", `${preco} T$`);
      if (espacos) por("Espaços", espacos);
      if (Number(sistema.defesa) > 0) por("Defesa", `+${sistema.defesa}`);
      if (Number(sistema.penalidade) < 0) por("Penalidade", sistema.penalidade);
      break;
    }
    case "classe": {
      por("Nível", sistema.nivel);
      break;
    }
    default:
      break;
  }

  return linhas;
}

/**
 * O item que originou o efeito, com o que a tela precisa para mostrá-lo.
 *
 * Duas procedências: o efeito **mora** no item (o caso comum — o poder, a
 * armadura), ou foi copiado para a ficha e guarda no `origin` o endereço de
 * onde veio (é o que acontece quando um poder liga o efeito, aqui ou pelo card
 * do sistema). A segunda também resolve o efeito que outro personagem aplicou:
 * a origem é o item dele, e é justamente o que o jogador quer ver ao perguntar
 * "de onde veio isto?".
 */
function origemDoEfeito(efeito) {
  let item = efeito.parent?.documentName === "Item" ? efeito.parent : null;

  if (!item && efeito.origin) {
    try {
      const alvo = fromUuidSync(efeito.origin);
      if (alvo?.documentName === "Item") item = alvo;
    } catch {
      // Endereço de compêndio (que `fromUuidSync` não resolve sem carregar) ou
      // documento que já não existe: fica sem origem, como estava.
    }
  }

  if (!item) return null;
  return {
    id: item.id,
    nome: item.name,
    img: item.img,
    tipo: t20Localize(`TYPES.Item.${item.type}`, item.type),
    dados: dadosDaOrigem(item),
    descricao: resolverReferencias(item.system?.description?.value)
  };
}

/**
 * Efeitos que valem na ficha — os do próprio ator e os que vêm dos itens
 * equipados/possuídos, que é como o Foundry os aplica.
 *
 * Fora da lista ficam os **de uso** (`onuse`): aqueles não valem sozinhos, são
 * as opções que aparecem ao conjurar ou ativar algo, e já têm lugar próprio
 * nos painéis de uso. Misturá-los aqui daria a entender que o personagem está
 * com trinta bônus ligados o tempo todo.
 */
export function getEfeitos(actor) {
  // `allApplicableEffects` junta os do ator com os que moram nos itens dele.
  // Ele é o único caminho desde o v14: o Foundry não copia mais o efeito do
  // item para a ficha (a "transferência legada" acabou), então varrer só
  // `actor.effects` deixaria de fora tudo que vem de poder e equipamento.
  const todos = [...actor.allApplicableEffects()];
  const rollData = actor.getRollData();

  return todos
    .filter((efeito) => !ehEfeitoDeUso(efeito))
    .map((efeito) => {
      const origem = origemDoEfeito(efeito);
      const duracao = textoDaDuracao(efeito);
      const ativo = !efeito.disabled && !efeito.isSuppressed;
      return {
        id: efeito.id,
        nome: efeito.name || origem?.nome || "Efeito",
        img: efeito.img || origem?.img || "",
        /** O poder, o item ou a magia de onde ele veio; null quando foi posto direto na ficha. */
        origem,
        descricao: resolverReferencias(efeito.description),
        duracao,
        // Suprimido é o efeito que existe mas não conta agora — a armadura
        // guardada na mochila, o efeito que outro sobrepõe.
        ativo,
        /** "temporario", "passivo" ou "inativo" — é por aqui que a lista se agrupa. */
        tipo: tipoDoEfeito(ativo, duracao),
        /** Mora na ficha, e não num item: só esse o jogador pode tirar daqui. */
        removivel: efeito.parent?.documentName !== "Item",
        mudancas: mudancasDoEfeito(efeito).map((mudanca) => ({
          /** A chave crua, para o app poder reescrever o rótulo sem tocar no módulo. */
          chave: String(mudanca.key ?? ""),
          rotulo: rotuloDaMudanca(actor, mudanca.key),
          modo: modoDaMudanca(mudanca.type),
          valor: valorDaMudanca(mudanca.value, rollData)
        }))
      };
    })
    .sort(
      (a, b) =>
        ORDEM_DOS_EFEITOS[a.tipo] - ORDEM_DOS_EFEITOS[b.tipo] ||
        a.nome.localeCompare(b.nome, "pt-BR")
    );
}

// ---------------------------------------------------------------------------
// Ativar um poder: os efeitos que ele liga e o card no chat
//
// Poderes como Fúria, Frenesi ou Torcida não são só uma linha de regra: eles
// ligam um Active Effect na ficha enquanto duram. No Foundry isso acontece ao
// usar o poder — o card de chat traz os efeitos e o jogador os aplica. Aqui o
// app faz a mesma coisa em um toque: cobra o custo, liga os efeitos escolhidos
// no próprio personagem e publica o card do sistema na mesa.
// ---------------------------------------------------------------------------

/** Onde marcamos, no efeito criado no ator, de que poder ele veio. */
const FLAG_ATIVACAO = "ativacao";

/**
 * Efeitos "de ativação" de um item: os Active Effects dele que **não** são
 * aprimoramentos. Aprimoramento (`onuse`) é escolha de uso e já tem lista
 * própria no painel; estes são o que o poder liga na ficha ao ser ativado.
 */
function efeitosDeAtivacao(item) {
  return [...(item.effects ?? [])].filter((efeito) => !ehEfeitoDeUso(efeito));
}

/** O efeito que este poder já ligou na ficha, se ainda estiver lá. */
function efeitoJaLigado(actor, item, efeito) {
  return (
    [...(actor.effects ?? [])].find((ef) => {
      const marca = ef.flags?.[MODULE_ID]?.[FLAG_ATIVACAO];
      return marca?.itemId === item.id && marca?.efeitoId === efeito.id;
    }) ?? null
  );
}

/**
 * Duração do efeito a partir da duração do poder — a mesma conversão que o
 * sistema faz em `applyOnUseEffects`. Sem isto, um efeito de "1 rodada"
 * entraria na ficha sem prazo nenhum e ficaria lá até alguém reparar.
 *
 * No v14 a duração é `{ value, units, expiry }`, e as unidades do sistema são
 * as do core no singular ("round" → "rounds") — daí a checagem contra
 * `CONST.ACTIVE_EFFECT_DURATION_UNITS`. Cena e sustentada não têm contagem:
 * acabam num **evento** de expiração, que é justamente o que o v14 trouxe e
 * o que o T20 1.6 registra (`CONFIG.ActiveEffect.expiryEvents`) — antes
 * disto, "cena" virava um número alto de rodadas.
 *
 * `null` quer dizer "não sei converter" (instantânea, permanente, especial):
 * aí vale o que o próprio efeito declarar.
 */
function duracaoDeAtivacao(item) {
  const duracao = item.system?.duracao ?? {};
  const unidades = duracao.units;
  if (!unidades) return null;

  if (unidades === "scene") return { value: null, units: "rounds", expiry: "sceneEnd" };
  if (unidades === "sust") return { value: null, units: "rounds", expiry: "sustainEnd" };

  const doCore = `${unidades}s`;
  if (CONST.ACTIVE_EFFECT_DURATION_UNITS.includes(doCore)) {
    return { value: Number(duracao.value) || 1, units: doCore, expiry: "turnStart" };
  }
  return null;
}

/** Os dados de um Active Effect prontos para entrar numa ficha. */
function dadosDoEfeito(actor, item, efeito) {
  const dados = efeito.toObject();
  delete dados._id;
  const duracao = duracaoDeAtivacao(item);
  return {
    ...dados,
    name: dados.name || item.name,
    img: dados.img || item.img,
    disabled: false,
    origin: item.uuid,
    ...(duracao ? { duration: duracao } : {}),
    flags: {
      ...(dados.flags ?? {}),
      [MODULE_ID]: { [FLAG_ATIVACAO]: { itemId: item.id, efeitoId: efeito.id } }
    }
  };
}

/**
 * Os efeitos que a tela de ativação oferece. `marcado` reproduz a regra do
 * sistema: efeito habilitado no poder é o que ele sempre liga; desabilitado é
 * opção que o jogador escolhe na hora.
 */
export function getEfeitosDeAtivacao(actor, item) {
  return efeitosDeAtivacao(item).map((efeito) => ({
    id: efeito.id,
    nome: efeito.name || item.name,
    img: efeito.img || item.img,
    marcado: !efeito.disabled,
    /** Já está ligado na ficha por uma ativação anterior. */
    ligado: !!efeitoJaLigado(actor, item, efeito)
  }));
}

/**
 * Liga na ficha os efeitos escolhidos. Reativar um poder que já estava ligado
 * **renova**: o efeito antigo sai e entra um novo com a duração recomeçada, em
 * vez de empilhar duas Fúrias na mesma ficha.
 */
async function ligarEfeitos(actor, item, ids) {
  if (!Array.isArray(ids) || !ids.length) return [];

  const escolhidos = efeitosDeAtivacao(item).filter((efeito) => ids.includes(efeito.id));
  if (!escolhidos.length) return [];

  const repetidos = escolhidos.map((efeito) => efeitoJaLigado(actor, item, efeito)).filter(Boolean);
  if (repetidos.length) {
    await actor.deleteEmbeddedDocuments("ActiveEffect", repetidos.map((ef) => ef.id));
  }

  const novos = escolhidos.map((efeito) => dadosDoEfeito(actor, item, efeito));
  await actor.createEmbeddedDocuments("ActiveEffect", novos);
  return novos;
}

/**
 * O card do sistema no chat — o mesmo que o Foundry publica quando o poder é
 * usado por lá (`displayCard`, template `chat/chat-card.hbs`), com a descrição,
 * a linha de execução/alcance/duração e os botões de aplicar efeito em outros
 * alvos (é assim que o mestre estende a Torcida aos aliados).
 *
 * Três desvios do caminho nativo, todos deliberados:
 *
 * - **não passa por `item.roll()`**: aquele caminho rola os dados do item, e
 *   o princípio do projeto é que quem rola é a mesa, no dado físico. Aqui só
 *   se exibe o card;
 * - **custo zerado no card**: o card do sistema traz um botão "gastar PM", e
 *   a essa altura o app já cobrou — com aprimoramentos e conferência de saldo.
 *   O que foi gasto vai no `flavor` da mensagem, como texto. No T20 1.6 o
 *   valor exibido passou a vir de `options.manaCost`, em vez de o `displayCard`
 *   recalculá-lo a partir do item — então zerá-lo é dizer isso, e não mais
 *   clonar o item com o custo em zero;
 * - **autor é o jogador**, não o mestre em cujo client isto roda.
 */
async function anunciarAtivacao(actor, user, item, { pm, gastos, aprimoramentos, efeitos }) {
  const gasto = textoDoGasto(pm, gastos);
  const nomes = nomesDeAprimoramentos(actor, aprimoramentos);

  let dados;
  try {
    dados = await item.displayCard({
      options: {
        itemId: item.id,
        // Zero: o botão de gastar PM do card não aparece, e o gasto vai no flavor.
        manaCost: 0,
        // Os aprimoramentos marcados, no formato que o template espera.
        onUseEffects: nomes.map((nome) => ({ cost: "", qty: 1, description: escaparHtml(nome) })),
        // Array de arrays: é como `_onChatCardApplyEffect` lê os efeitos do card.
        effects: efeitos.map((efeito) => [efeito])
      },
      createMessage: false
    });
  } catch (erro) {
    // O card é do sistema, e monta muita coisa (descrição enriquecida,
    // condições citadas no texto, rolagens). Se ele falhar, o poder já foi
    // ativado e o custo já saiu da ficha — a mesa precisa saber disso de
    // qualquer jeito, então cai no aviso simples em vez de derrubar o uso.
    warn(`O card de "${item.name}" não pôde ser montado: ${erro.message}`);
    return anunciarGasto(actor, user, item.name, pm, gastos);
  }

  return ChatMessage.implementation.create({
    ...dados,
    author: user?.id ?? game.user.id,
    flavor: gasto ? `Gastou ${gasto}.` : dados.flavor
  });
}

/**
 * O gasto de um uso inteiro: os PM e os itens que ele consome, mais o aviso
 * no chat. É o que o botão "Gastar" do app dispara.
 *
 * O app manda ids e quantidades, nunca texto pronto nem nome de item: quem
 * resolve nome, quantidade disponível e o que escrever no chat é o Foundry,
 * aqui. E a conferência vem toda antes de qualquer escrita — a tela pode
 * estar velha (a última flecha foi gasta na mesa, o PM saiu por outro
 * caminho), e nesse caso é melhor recusar o uso inteiro do que gastar metade
 * dele. O erro volta pro app, que repede a ficha.
 */
export async function gastarUso(actor, user, uso = {}) {
  const pm = Math.max(0, Math.floor(Number(uso.pm) || 0));

  // Agrupado por item: o mesmo consumível pode chegar duas vezes (o material
  // declarado na magia e um aprimoramento que sai do mesmo pote).
  const pedidos = new Map();
  for (const bruto of Array.isArray(uso.itens) ? uso.itens : []) {
    const quantidade = Math.max(0, Math.floor(Number(bruto?.quantidade) || 0));
    if (!bruto?.itemId || !quantidade) continue;
    pedidos.set(bruto.itemId, (pedidos.get(bruto.itemId) ?? 0) + quantidade);
  }

  const gastos = [];
  for (const [itemId, quantidade] of pedidos) {
    const item = actor.items.get(itemId);
    if (!item) throw new Error("Um dos itens deste uso não está mais na ficha.");
    const disponivel = Number(item.system?.qtd ?? 0) || 0;
    if (disponivel < quantidade) {
      throw new Error(`${actor.name} não tem ${quantidade} × ${item.name} — só ${disponivel}.`);
    }
    gastos.push({ item, quantidade, restante: disponivel - quantidade });
  }

  const pmDoAtor = actor.system?.attributes?.pm ?? {};
  const pmDisponivel = (Number(pmDoAtor.value) || 0) + (Number(pmDoAtor.temp) || 0);
  if (pm > pmDisponivel) {
    throw new Error(`${actor.name} não tem ${pm} PM — só ${pmDisponivel}.`);
  }

  if (pm > 0) await gastarPM(actor, pm);

  for (const { item, restante } of gastos) {
    // Zerado o item fica, com quantidade 0: "acabou" não é "não tenho". A
    // aljava vazia continua sendo a aljava, e reabastecer é somar no
    // contador da mochila, não recadastrar o item.
    await item.update({ "system.qtd": restante });
  }

  // `origemId` é o item que originou o uso (hoje, o poder ativado): com ele a
  // ativação vai inteira — liga os efeitos escolhidos na ficha e publica o card
  // do sistema —, e é o que faz um poder sem custo ainda ter o que anunciar.
  const origem = uso.origemId ? actor.items.get(uso.origemId) : null;
  if (origem) {
    const efeitos = await ligarEfeitos(actor, origem, uso.efeitos);
    return anunciarAtivacao(actor, user, origem, {
      pm,
      gastos,
      aprimoramentos: uso.aprimoramentos,
      efeitos
    });
  }

  return anunciarGasto(actor, user, uso.acao, pm, gastos);
}

// ---------------------------------------------------------------------------
// Aprimoramentos de teste de perícia — o que dá pra gastar PM ao rolar
// ---------------------------------------------------------------------------

/**
 * Converte o valor de um `change` de Active Effect em número. Pode ser um
 * literal ("2") ou uma fórmula do sistema ("@int", "@meionivel"), que só
 * resolve com os dados do ator.
 */
function valorNumerico(actor, bruto) {
  if (bruto === null || bruto === undefined) return null;
  const direto = Number(bruto);
  if (Number.isFinite(direto)) return direto;
  try {
    const formula = Roll.replaceFormulaData(String(bruto), actor.getRollData(), { missing: "0" });
    const valor = Roll.safeEval(formula);
    return Number.isFinite(valor) ? valor : null;
  } catch {
    return null;
  }
}

/**
 * O `mode` numérico que o app ainda usa para saber se um aprimoramento
 * substitui o campo (5) ou soma nele. O Foundry v14 passou a dizer isso em
 * texto, e a tradução mora aqui para o contrato com o front-end seguir o
 * mesmo — nada muda do lado de lá por causa da migração.
 *
 * "add", "subtract" e "custom" caem no padrão 2 (soma), que é como o app os
 * trata de qualquer forma.
 */
const MODO_LEGADO_DO_TIPO = { multiply: 1, downgrade: 3, upgrade: 4, override: 5 };

function modoLegado(tipo) {
  return MODO_LEGADO_DO_TIPO[String(tipo ?? "")] ?? 2;
}

/**
 * Escopos de um Active Effect "de uso" (`onuse`), como o próprio sistema os
 * nomeia no schema (`system.abilityUse.types`, ver `BaseEffect`). Um efeito
 * pode marcar mais de um. Até o T20 1.5 cada escopo era uma flag separada;
 * hoje é um `Set` com estas chaves.
 */
const ESCOPOS_APRIMORAMENTO = [
  "skill",
  "attack",
  "ability",
  "spell",
  "power",
  "equipment",
  "consumable",
  "self"
];

/**
 * Ícone genérico que o Foundry dá a um efeito recém-criado. Não diz nada — a
 * imagem do poder que originou o efeito é o que identifica a habilidade.
 */
function eIconeGenerico(caminho) {
  return !caminho || /^icons\/svg\//.test(String(caminho));
}

/**
 * O poder (ou item) que originou o efeito. Quando o efeito está gravado no
 * ator e não no item, o vínculo fica em `origin`, um uuid no formato
 * "Actor.<id>.Item.<id>" — o último trecho é o item dentro deste mesmo ator.
 */
function itemDeOrigem(actor, efeito) {
  const partes = String(efeito?.origin ?? "").split(".");
  const id = partes.at(-1);
  return partes.at(-2) === "Item" && id ? actor.items?.get?.(id) ?? null : null;
}

/**
 * Tudo que o personagem pode ativar durante um uso, com o custo em PM e os
 * modificadores que aplica. É o mecanismo nativo do sistema — Active Effects
 * marcados `onuse` (ver `validOnUseEffects`/`applyOnUseEffects` em
 * tormenta20.mjs) — mapeado inteiro, para qualquer escopo.
 *
 * Detalhes do formato que não são óbvios:
 *
 * - **`disabled: true` é o estado normal** de um efeito `onuse`: ele fica
 *   desligado porque só vale quando escolhido no uso. Filtrar por `disabled`
 *   descartaria todos — e quem diz que o aprimoramento é automático (o "+1 na
 *   CD" que o personagem tem sempre) é `abilityUse.automatic`, campo próprio
 *   desde o T20 1.6; antes disso era o `disabled` que carregava as duas
 *   informações.
 * - **O efeito costuma morar no item, não no ator** (`transfer: false`), então
 *   varremos `item.effects` além de `actor.effects`.
 * - **`custo` é número ou `null`** (nulo = de graça; negativo = reduz). Era
 *   texto até o 1.5.
 * - **Os valores dos `changes` podem ser fórmula** ("@int", "1d8"): o que
 *   resolve para número vem em `valor`; o resto fica só em `formula`.
 */
export function getAprimoramentos(actor) {
  const lista = [];
  const vistos = new Set();

  function registrar(efeito, itemPai) {
    if (!ehEfeitoDeUso(efeito)) return;

    const uso = dadosDeUso(efeito);
    const escopos = ESCOPOS_APRIMORAMENTO.filter((escopo) => uso.types?.has?.(escopo));
    if (!escopos.length) return;

    const item = itemPai ?? itemDeOrigem(actor, efeito);
    const nome = efeito.name || item?.name || "Aprimoramento";
    const custo = Number(uso.custo) || 0;
    // A chave de deduplicação é a origem + o nome + o custo, e cada pedaço
    // resolve um caso medido em ficha de verdade:
    //
    // - **origem**: escrever um pergaminho copia os efeitos da magia com nome
    //   e custo iguais. Sem ela, o pergaminho herdava os aprimoramentos da
    //   magia — isto é, sumiam do painel dele, que os acha pela origem.
    // - **nome + custo, e não o id do efeito**: dois documentos diferentes
    //   podem ser o mesmo aprimoramento aos olhos do jogador (o Líquen Lilás
    //   que está no item e na ficha). Deduplicar por id deixaria os dois
    //   passarem. O caso mais comum disso — a cópia que o Foundry fazia no
    //   ator de todo efeito `transfer: true` — acabou no v14, mas a chave
    //   continua valendo para o resto.
    const origem = item?.id ?? "ator";
    const chave = `${origem}|${nome}|${custo}`;
    if (vistos.has(chave)) return;
    vistos.add(chave);

    const modificadores = mudancasDoEfeito(efeito).map((change) => ({
      chave: String(change?.key ?? ""),
      valor: valorNumerico(actor, change?.value),
      formula: String(change?.value ?? ""),
      // Modo do Active Effect: 5 (SUBSTITUI) troca o campo — "o alcance passa
      // a ser curto" —, os outros somam ao que já havia. Sem isso não dá pra
      // saber se um aprimoramento de alcance substitui ou acrescenta.
      modo: modoLegado(change?.type)
    }));

    lista.push({
      // Prefixado pela origem pelo mesmo motivo: magia e pergaminho carregam
      // efeitos de id idêntico, e o id daqui é chave de lista na tela.
      id: `${origem}-${efeito.id ?? nome}`,
      // Efeito "de uso" habilitado na ficha é aprimoramento que o personagem
      // tem ligado o tempo todo (o "+1 na CD" do Xamã Místico), não uma opção
      // a marcar na hora. Os demais chegam desabilitados justamente porque
      // são escolha de uso.
      ativoPorPadrao: !!uso.automatic,
      // De qual item o efeito veio: um efeito de escopo "self" só vale para
      // o próprio item (a "Maciça" é upgrade de uma arma, não de todas).
      origemId: item?.id ?? null,
      nome,
      // A imagem do poder identifica a habilidade; a do efeito costuma ser o
      // ícone genérico do Foundry, que não diz nada. Só caímos nela quando o
      // efeito tem imagem própria de verdade e não há item de origem.
      img: item?.img || (eIconeGenerico(efeito.img) ? "" : efeito.img),
      descricao: resolverReferencias(uso.description || efeito.description || item?.system?.description?.value),
      custo,
      escopos,
      restritoA: [...(uso.names ?? [])],
      // Aprimoramento que mora num consumível é o consumível sendo usado: o
      // pó que se joga na magia, a erva que se mastiga antes do teste. Marcar
      // na tela é gastar uma unidade dele.
      //
      // Menos os de escopo "self", que são o próprio item dizendo de quantos
      // jeitos ele pode ser usado — os aprimoramentos da magia dentro do
      // pergaminho. Esses não gastam um segundo pergaminho: quem cobra a
      // unidade é o uso em si (o `consumeSelf`).
      consumo:
        item?.type === "consumivel" && !escopos.includes("self") ? consumoDeItem(item, 1) : null,
      modificadores,
      // Aprimoramento repetível: pode ser aplicado mais de uma vez, pagando de novo.
      aumenta: !!uso.aumenta
    });
  }

  for (const item of actor.items ?? []) {
    for (const efeito of item.effects ?? []) registrar(efeito, item);
  }
  for (const efeito of actor.effects ?? []) registrar(efeito, null);

  return lista;
}



// ---------------------------------------------------------------------------
// Armas: ataque, dano e crítico decompostos
// ---------------------------------------------------------------------------

function labelPericia(chave) {
  return t20Config().pericias?.[chave]?.label ?? chave;
}

/**
 * Bônus de ataque da arma, decomposto. Espelha `getAttackToHit` do sistema
 * (tormenta20.mjs): o valor vem da perícia da arma (Luta ou Pontaria), com a
 * troca de atributo quando ela usa outro que não o padrão da perícia — é o
 * caso de acuidade, arremesso e afins, que o sistema resolve trocando o
 * modificador dentro do próprio valor da perícia.
 */
function getAtaqueDaArma(actor, arma, rollData) {
  const rolAtaque = (arma.system?.rolls ?? []).find((r) => r.type === "ataque");
  if (!rolAtaque?.parts?.length) return null;

  const chavePericia = rolAtaque.parts[1]?.[0];
  const pericia = chavePericia ? actor.system?.pericias?.[chavePericia] : null;
  const atributos = actor.system?.atributos ?? {};
  const itens = [];
  let total = 0;

  if (pericia) {
    total += pericia.value ?? 0;
    itens.push({ rotulo: labelPericia(chavePericia), valor: pericia.value ?? 0 });

    // A arma pode fixar outro atributo para o teste (parts[1][1]).
    const atributoForcado = rolAtaque.parts[1]?.[1];
    if (atributoForcado && atributoForcado !== pericia.atributo) {
      const delta = (atributos[atributoForcado]?.value ?? 0) - (atributos[pericia.atributo]?.value ?? 0);
      if (delta) {
        total += delta;
        itens.push({ rotulo: `Usa ${localizeAtributo(atributoForcado)}`, valor: delta });
      }
    }
  }

  const bonusDaArma = Number(rolAtaque.parts[2]?.[0]) || 0;
  if (bonusDaArma) {
    total += bonusDaArma;
    itens.push({ rotulo: "Bônus da arma", valor: bonusDaArma });
  }

  // Modificadores globais de ataque que o mestre configura em efeitos.
  const corpoACorpo = chavePericia !== "pont";
  const globais = [
    ...getModificadoresNomeados(actor, "system.modificadores.ataque.geral", rollData),
    ...(corpoACorpo ? getModificadoresNomeados(actor, "system.modificadores.ataque.cac", rollData) : []),
    ...(!corpoACorpo ? getModificadoresNomeados(actor, "system.modificadores.ataque.ad", rollData) : [])
  ];
  for (const modificador of globais) {
    total += modificador.valor;
    itens.push(modificador);
  }

  return {
    pericia: chavePericia ? labelPericia(chavePericia) : "",
    total,
    totalFormatado: formatarBonus(total),
    itens
  };
}

/**
 * Dano da arma. Cada parte é um pedaço da fórmula ("1d8", "@for") com o tipo
 * de dano quando declarado. As que resolvem para número entram somadas; os
 * dados ficam como estão, porque quem rola é a mesa.
 */
/**
 * O campo `alcance` guarda a chave em inglês ("short", "medium"); quem
 * traduz é `CONFIG.T20.distanceUnits`, que o sistema já localiza no boot
 * (preLocalize).
 *
 * Vazio e "-" não são ausência de informação: é assim que o sistema marca
 * arma de corpo a corpo, que não tem alcance a declarar. Por isso viram um
 * rótulo próprio, e não uma etiqueta em branco.
 */
function labelAlcance(chave) {
  if (!chave || chave === "-") return t20Localize("T20.Melee", "Corpo a Corpo");
  return t20Config().distanceUnits?.[chave] ?? chave;
}

/** "@for" vira "Força"; o resto da fórmula fica como está. */
function rotuloDaParteDeDano(formula) {
  const atributo = String(formula).match(/^@(\w+)$/)?.[1];
  return atributo ? localizeAtributo(atributo) : String(formula);
}

function getDanoDaArma(arma, rollData) {
  const rolagens = (arma.system?.rolls ?? []).filter((r) => r.type === "dano");

  return rolagens.map((rolagem) => {
    const dados = [];
    let fixo = 0;
    const itens = [];

    for (const [formula, tipo] of rolagem.parts ?? []) {
      if (!formula) continue;
      const texto = String(formula);
      const valor = avaliarFormula(texto, rollData);

      if (valor !== null && !/d\d/i.test(texto)) {
        fixo += valor;
        itens.push({ rotulo: rotuloDaParteDeDano(texto), valor });
      } else if (/^\d*d\d+/i.test(texto)) {
        dados.push(texto);
        // O dado base da arma vira uma linha nomeada; o tipo de dano já
        // aparece no título da seção, então não se repete aqui.
        itens.push({ rotulo: "Dano da arma", valor: 0, dado: texto });
      }
      // O que sobra é marcador do sistema, não parte da rolagem: armas de
      // disparo trazem "padrao" no lugar do atributo, querendo dizer que o
      // dano não soma modificador nenhum. Exibir isso seria ruído.
    }

    const partes = [...dados];
    if (fixo) partes.push(formatarBonus(fixo).replace("+", "+ "));

    return {
      nome: rolagem.name || "Dano",
      formula: partes.join(" ").trim() || "—",
      tipo: (rolagem.parts ?? []).map(([, t]) => t).find(Boolean) ?? "",
      fixo,
      itens
    };
  });
}

/**
 * Armas do personagem, com o ataque e o dano já decompostos. O app nunca
 * rola: entrega a fórmula pronta para o dado da mesa.
 */
/** O que está no baú não vai para o Combate: não está com o personagem. */
const estaNaMochila = (item) => item.system?.carregado !== false;

export function getArmas(actor) {
  const rollData = actor.getRollData();

  return actor.items
    .filter((item) => item.type === "arma" && estaNaMochila(item))
    .map((arma) => {
      const ataque = getAtaqueDaArma(actor, arma, rollData);
      const margem = Number(arma.system?.criticoM) || 20;
      const multiplicador = Number(arma.system?.criticoX) || 2;

      return {
        id: arma.id,
        nome: arma.name,
        img: arma.img,
        equipado: !!arma.system?.equipado,
        slot: lerSlot(arma),
        tipoSlot: arma.system?.equipado2?.type ?? "",
        duasMaos: arma.system?.empunhadura === "duas",
        descricao: resolverReferencias(arma.system?.description?.value),
        alcance: labelAlcance(arma.system?.alcance),
        ataque,
        dano: getDanoDaArma(arma, rollData),
        critico: {
          margem,
          multiplicador,
          // "19" já se lê como "19 e 20" na mesa; o "+" era redundante.
          texto: `${margem} / ×${multiplicador}`
        },
        consumo: consumoDeclarado(actor, arma)
      };
    });
}

// ---------------------------------------------------------------------------
// Equipar: slots de mão e de vestido
//
// Com a opção "equipmentSlots" ligada no mundo, o sistema deixa de tratar
// "equipado" como sim/não e passa a usar `equipado2.slot`, um número decimal
// que carrega duas informações:
//
//   parte inteira → índice do slot (1..limite, ou 12 = as duas mãos)
//   primeira casa → tipo do slot (1 = mão, 2 = vestido)
//
// Ou seja: 2.1 é "mão 2", 12.1 é "ocupando as duas mãos", 1.2 é "vestido 1".
// Zero significa desequipado. Ver `_onToggleItem` em tormenta20.mjs.
// ---------------------------------------------------------------------------

const SLOT_DUAS_MAOS = 12;
const TIPO_MAO = 1;
const TIPO_VESTIDO = 2;

function usaSlots() {
  try {
    return !!game.settings.get("tormenta20", "equipmentSlots");
  } catch {
    return false;
  }
}

/** Decompõe `equipado2.slot` em algo legível pelo front. */
function lerSlot(item) {
  const bruto = Number(item.system?.equipado2?.slot) || 0;
  if (!bruto) return null;
  const indice = Math.floor(bruto);
  // A casa decimal é o tipo; o arredondamento evita o 0.30000000000000004.
  const tipo = Math.round((bruto % 1) * 10);
  return {
    indice,
    tipo: tipo === TIPO_VESTIDO ? "vestido" : "mao",
    duasMaos: indice === SLOT_DUAS_MAOS
  };
}

export function getConfigEquipamento(actor) {
  const equipamentos = actor.system?.equipamentos ?? {};
  return {
    usaSlots: usaSlots(),
    limiteMaos: Number(equipamentos.limiteEmpunhado) || 0,
    limiteVestido: Number(equipamentos.limiteVestido) || 0
  };
}

/**
 * Coloca um item num slot, replicando `_onToggleItem` do sistema. Passar o
 * item que já está no slot em `idAtual` faz a troca; passar o próprio item
 * desequipa.
 *
 * As duas regras de conflito são do sistema:
 *  - ocupar as duas mãos (12) libera as mãos 1 e 2, e vice-versa;
 *  - vestir armadura leve ou pesada tira a outra, porque não se usa as duas.
 */
export async function equiparEmSlot(actor, itemId, contexto, indice, idAtual = null) {
  const item = actor.items.get(itemId);
  if (!item) throw new Error("Item não encontrado.");

  const atualizacoes = [];
  const desequipar = (id) => atualizacoes.push({ _id: id, "system.equipado2.slot": 0, "system.equipado": false });

  if (idAtual) desequipar(idAtual);

  // Tocar no slot onde o próprio item já está = tirar do slot.
  if (item.id !== idAtual) {
    if (contexto === "hand") {
      atualizacoes.push({
        _id: item.id,
        "system.equipado2.slot": indice + TIPO_MAO / 10,
        "system.equipado": true
      });
      const conflitantes = indice === SLOT_DUAS_MAOS ? [1.1, 2.1] : [SLOT_DUAS_MAOS + 0.1];
      for (const outro of actor.items) {
        if (outro.id === item.id) continue;
        if (conflitantes.includes(Number(outro.system?.equipado2?.slot))) desequipar(outro.id);
      }
    } else if (contexto === "body") {
      atualizacoes.push({
        _id: item.id,
        "system.equipado2.slot": indice + TIPO_VESTIDO / 10,
        "system.equipado": true
      });
      const armaduras = ["leve", "pesada"];
      if (armaduras.includes(item.system?.tipo)) {
        for (const outro of actor.items) {
          if (outro.id === item.id) continue;
          if (armaduras.includes(outro.system?.tipo) && Number(outro.system?.equipado2?.slot)) {
            desequipar(outro.id);
          }
        }
      }
    } else {
      throw new Error(`Contexto de equipamento desconhecido: "${contexto}".`);
    }
  }

  return actor.updateEmbeddedDocuments("Item", atualizacoes);
}

/**
 * Armaduras e escudos: o que entra na Defesa e pesa nos testes. Ficam à parte
 * do inventário geral porque, junto das armas, são o que se troca durante uma
 * luta — e a penalidade de armadura afeta perícias, não só a proteção.
 */
export function getProtecoes(actor) {
  return actor.items
    .filter(
      (item) =>
        item.type === "equipamento" && estaNaMochila(item) && (Number(item.system?.armadura?.value) || 0) > 0
    )
    .map((item) => {
      const armadura = item.system?.armadura ?? {};
      return {
        id: item.id,
        nome: item.name,
        img: item.img,
        equipado: !!item.system?.equipado,
        slot: lerSlot(item),
        tipoSlot: item.system?.equipado2?.type ?? "",
        duasMaos: false,
        descricao: resolverReferencias(item.system?.description?.value),
        // "escudo", "leve" ou "pesada" — o sistema separa por aí.
        tipo: item.system?.tipo ?? "",
        defesa: Number(armadura.value) || 0,
        penalidade: Number(armadura.penalidade) || 0,
        reducaoDano: Number(item.system?.rd) || 0
      };
    });
}

// ---------------------------------------------------------------------------
// Ficha completa — payload único enviado ao front-end via socket (ver
// scripts/relay.mjs). Junta tudo que as funções acima já sabem ler; nenhum
// campo novo é lido aqui.
// ---------------------------------------------------------------------------

export function getFichaCompleta(actor) {
  // Uma passada só pelos efeitos para a ficha inteira: sem isto, cada perícia
  // faz seis consultas e cada uma revarreria todos os efeitos do ator.
  cacheDeModificadores.set(actor, modificadoresPorChave(actor));
  try {
    return montarFichaCompleta(actor);
  } finally {
    cacheDeModificadores.delete(actor);
  }
}

function montarFichaCompleta(actor) {
  const pvData = getPV(actor);
  const pmData = getPM(actor);
  const defesaData = getDefesa(actor);
  const movimento = getMovimento(actor);

  const atributos = getAtributosChaves().map((chave) => {
    const dado = getAtributo(actor, chave);
    return {
      chave,
      sigla: localizeAtributoAbr(chave),
      nome: localizeAtributo(chave),
      mod: dado.mod,
      modFormatado: formatarBonus(dado.mod),
      itens: dado.itens
    };
  });

  const pericias = getPericias(actor).map((pericia) => ({
    ...pericia,
    formula: getFormulaPericia(actor, pericia.chave)
  }));

  return {
    id: actor.id,
    nome: actor.name,
    img: actor.img,
    nivel: getNivel(actor),
    xp: getXp(actor),
    raca: getRaca(actor),
    origem: getOrigem(actor),
    divindade: getDivindade(actor),
    classes: getClasses(actor),
    atributos,
    pv: pvData,
    pm: pmData,
    defesa: defesaData,
    movimento,
    recursosGenericos: getRecursosGenericos(actor),
    tamanho: getTamanho(actor),
    sentidos: getSentidos(actor),
    resistencias: getResistencias(actor),
    imunidadesCondicoes: getImunidadesCondicoes(actor),
    profArmas: getProficienciaArmas(actor),
    profArmaduras: getProficienciaArmaduras(actor),
    pericias,
    dinheiro: getDinheiro(actor),
    inventario: getInventario(actor),
    carga: getCarga(actor),
    poderes: getPoderes(actor),
    magias: getMagias(actor),
    aprimoramentos: getAprimoramentos(actor),
    efeitos: getEfeitos(actor),
    armas: getArmas(actor),
    protecoes: getProtecoes(actor),
    configEquipamento: getConfigEquipamento(actor)
  };
}
