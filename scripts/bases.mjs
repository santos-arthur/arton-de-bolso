/**
 * Bases: a ponte com o módulo `t20-bases`.
 *
 * A base é um Actor do próprio sistema (`bases`), ligada ao personagem de duas
 * formas: o proprietário (flag do módulo), que administra, e os residentes
 * (`system.residentes`), que recebem os bônus. Tudo que é regra — o que cada
 * cômodo dá, o card no chat, o registro — continua sendo do módulo, chamado
 * pela API pública (`game.modules.get(...).api`). Aqui só se monta o que a
 * tela precisa e se traduz o d20 da mesa num teste pronto.
 *
 * Construir, ampliar, reformar, erguer cômodos e mexer em mobílias e
 * residentes ficam de fora de propósito: é o mestre quem faz, pela ficha do
 * próprio módulo. O app mostra a base, o que ela dá a quem mora nela, e cuida
 * do que se repete a cada aventura — manutenção, reparo e o rendimento do
 * Empreendimento.
 */

const MODULO_BASES = "t20-bases";
const TIPO_BASE = "bases";
const TIPO_EMPREENDIMENTO = "empreendimento";
const CONFIG_EMPREENDIMENTO_NEGOCIO = "empreendimentoComoNegocio";
const MODULO_NEGOCIOS = "t20-negocios";

/** Quantas entradas do registro vão para a tela — o resto fica no Foundry. */
const LIMITE_REGISTRO = 10;

/** A API do módulo, ou null quando ele não está ativo neste mundo. */
function api() {
  const modulo = game.modules.get(MODULO_BASES);
  return modulo?.active ? (modulo.api ?? null) : null;
}

/**
 * O módulo está ativo e já publicou a API? Diferente dos negócios, o tipo de
 * Ator existe sem o módulo — é do sistema —, então é a API que decide.
 */
export function disponivel() {
  const modulo = api();
  return !!(modulo?.Operacoes && modulo?.lerBase);
}

export function ehBase(actor) {
  return actor?.type === TIPO_BASE;
}

function flag(doc, chave) {
  return doc?.getFlag?.(MODULO_BASES, chave) ?? null;
}

function residentesDe(base) {
  return [...(base.system?.residentes ?? [])];
}

/**
 * Quem administra a base, do ponto de vista de `user` — o `podeAdministrar`
 * do módulo olha `game.user`, que aqui é sempre o mestre. Mesma regra, por
 * usuário: dono do Ator da base e, havendo proprietário, dono dele também.
 */
function administra(base, user) {
  if (!base.testUserPermission(user, "OWNER")) return false;
  const proprietario = game.actors.get(flag(base, "proprietario") ?? "");
  return proprietario ? proprietario.testUserPermission(user, "OWNER") : true;
}

/**
 * As bases deste personagem — dele ou em que ele mora. Como nos negócios, a
 * posse do documento da base não entra na conta para ver: quem chegou aqui
 * já enxerga o personagem, e uma base criada pelo mestre nem sempre dá
 * ownership aos residentes. Administrar continua exigindo (ver `administra`).
 */
function basesDoAtor(actor) {
  return game.actors
    .filter((a) => ehBase(a) && (flag(a, "proprietario") === actor.id || residentesDe(a).includes(actor.id)))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

/** Texto puro da descrição de um Item — para cômodos e mobílias da casa. */
function textoDe(item) {
  return (item?.system?.description?.value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function rotuloDaEscolha(mobilia) {
  if (!mobilia.escolha || !mobilia.def?.escolha) return "";
  const def = mobilia.def.escolha;
  if (def.tipo === "opcoes") return def.opcoes?.[mobilia.escolha] ?? mobilia.escolha;
  return game.i18n.localize(CONFIG.T20?.pericias?.[mobilia.escolha]?.label ?? mobilia.escolha);
}

function mapearMobilia(m) {
  return {
    id: m.id,
    nome: m.nome,
    img: m.item.img || m.def?.icone || "",
    efeito: m.def?.efeito ?? textoDe(m.item),
    escolha: rotuloDaEscolha(m)
  };
}

function nomeDoTipo(leitura) {
  const tipo = leitura.tipo;
  if (!tipo) return leitura.tipoTexto || "";
  if (tipo.id !== "movel") return tipo.nome;
  const variante = tipo.variantes?.[leitura.variante]?.nome;
  return variante ? `${tipo.nome} (${variante})` : tipo.nome;
}

/** Bônus de Inteligência do personagem — o atributo do teste do Empreendimento. */
function bonusInteligencia(actor) {
  return Number(actor?.system?.atributos?.int?.value) || 0;
}

/**
 * O Empreendimento rende de um dos dois jeitos do livro: com o teste de
 * Inteligência, ou — com a configuração de negócios ligada — como um negócio
 * do t20-negocios, que rende pela tela de Negócios.
 */
function empreendimentoDe(leitura, actor) {
  if (leitura.tipo?.id !== TIPO_EMPREENDIMENTO) return null;
  const comoNegocio = !!game.settings.get(MODULO_BASES, CONFIG_EMPREENDIMENTO_NEGOCIO);
  if (comoNegocio) {
    return {
      modo: "negocio",
      moduloNegociosAtivo: !!game.modules.get(MODULO_NEGOCIOS)?.active,
      negocio: leitura.negocio
        ? { id: leitura.negocio.id, nome: leitura.negocio.name, nivel: leitura.negocio.system?.nivel ?? 1 }
        : null
    };
  }
  return {
    modo: "teste",
    bonusCapacidade: leitura.capacidade,
    bonusInteligencia: bonusInteligencia(actor),
    // O livro pede que quem rola seja um residente.
    podeRolar: residentesDe(leitura.actor).includes(actor.id)
  };
}

/**
 * Tudo que a tela precisa de uma base, em objeto simples: `lerBase` devolve
 * documentos vivos (Actor, Item), que não viajam pelo socket e quebrariam a
 * comparação "já mandei isto".
 */
function mapearBase(base, actor, user) {
  const { lerBase, Beneficios } = api();
  const leitura = lerBase(base);
  const souResidente = residentesDe(base).includes(actor.id);

  const nomeDe = (id) => game.actors.get(id)?.name ?? null;

  const comodos = leitura.comodos.map((c) => ({
    id: c.id,
    nome: c.nome,
    img: c.item.img || c.def?.icone || "",
    efeito: c.def?.efeito ?? textoDe(c.item),
    danificado: c.danificado,
    suite: !!c.limiteOcupantes,
    ocupantes: c.ocupantes.map(nomeDe).filter(Boolean),
    mobilias: c.mobilias.map(mapearMobilia)
  }));

  let beneficios = null;
  if (souResidente) {
    const { automaticos, lembretes, bloqueados } = Beneficios.beneficiosDe(leitura, actor.id);
    const simples = (b) => ({ nome: b.nome, efeito: b.efeito ?? "", naFicha: !!b.naFicha, naRolagem: !!b.naRolagem });
    beneficios = {
      automaticos: automaticos.map(simples),
      lembretes: lembretes.map(simples),
      bloqueados: bloqueados.map((b) => ({ nome: b.nome, motivo: game.i18n.localize(b.motivo) }))
    };
  }

  const registro = leitura.registro
    .slice(-LIMITE_REGISTRO)
    .reverse()
    .map((e) => ({ tipo: e.tipo, texto: e.texto ?? "", timestamp: e.timestamp ?? 0 }));

  return {
    id: base.id,
    nome: base.name,
    img: base.img,
    adquirida: leitura.adquirida,
    porte: leitura.porte.nome,
    posicaoPorte: api().Regras.indiceDoPorte(leitura.porteId) + 1,
    totalPortes: api().Regras.PORTES.length,
    capacidade: leitura.capacidade,
    usados: leitura.usados,
    tipo: nomeDoTipo(leitura),
    efeitoTipo: leitura.tipo?.efeito ?? "",
    seguranca: leitura.seguranca.efetiva,
    manutencao: leitura.manutencao,
    custoReparo: leitura.custoReparo,
    proprietario: leitura.proprietario?.name ?? null,
    souProprietario: leitura.proprietarioId === actor.id,
    souResidente,
    residentes: leitura.residentes.map((r) => ({ id: r.id, nome: r.name, img: r.img })),
    comodos,
    soltas: leitura.soltas.map(mapearMobilia),
    exteriores: leitura.exteriores.map(mapearMobilia),
    beneficios,
    empreendimento: empreendimentoDe(leitura, actor),
    registro,
    podeAdministrar: administra(base, user)
  };
}

/**
 * O estado da tela de bases para quem está olhando `actor`. Sem módulo, a
 * resposta é "indisponível" — e não um erro, como nos negócios.
 */
export function listarBases(actor, user) {
  if (!disponivel() || !actor) return { disponivel: disponivel(), bases: [] };
  return {
    disponivel: true,
    bases: basesDoAtor(actor).map((base) => mapearBase(base, actor, user))
  };
}

function exigirApi() {
  if (!disponivel()) throw new Error("O módulo Bases não está ativo neste mundo.");
  return api();
}

/**
 * A base que o front pediu, desde que seja deste personagem e quem pede a
 * administre. O id vem do celular, então é aqui que ele deixa de ser confiado.
 */
function baseAdministrada(actor, user, baseId) {
  const base = game.actors.get(baseId);
  if (!ehBase(base) || !(flag(base, "proprietario") === actor.id || residentesDe(base).includes(actor.id))) {
    throw new Error("Esta base não é do personagem aberto.");
  }
  if (!administra(base, user)) throw new Error(`Você não administra ${base.name}.`);
  return base;
}

/**
 * O início de uma aventura: paga a manutenção, ou deixa de pagar e um cômodo
 * se danifica — o escolhido, ou um sorteado entre os inteiros. O dinheiro não
 * sai da ficha: como no módulo, o valor vai para o card do chat.
 */
export async function iniciarAventura(actor, user, { baseId, pagar, danificarId = null } = {}) {
  const { Operacoes, lerBase } = exigirApi();
  const base = baseAdministrada(actor, user, baseId);

  if (pagar) return Operacoes.iniciarAventura(base, { pagar: true });

  const inteiros = lerBase(base).comodos.filter((c) => !c.danificado);
  let alvo = null;
  if (danificarId === "sorteio") {
    alvo = inteiros.length ? inteiros[Math.floor(Math.random() * inteiros.length)].id : null;
  } else if (danificarId) {
    if (!inteiros.some((c) => c.id === danificarId)) throw new Error("Esse cômodo não está inteiro nesta base.");
    alvo = danificarId;
  }
  return Operacoes.iniciarAventura(base, { pagar: false, danificarId: alvo });
}

/** Repara um cômodo danificado. O custo vai para o card do chat. */
export async function repararComodo(actor, user, { baseId, comodoId } = {}) {
  const { Operacoes, lerBase } = exigirApi();
  const base = baseAdministrada(actor, user, baseId);
  const comodo = lerBase(base).comodos.find((c) => c.id === comodoId);
  if (!comodo) throw new Error("Cômodo não encontrado nesta base.");
  if (!comodo.danificado) throw new Error(`${comodo.nome} não está danificado.`);
  return Operacoes.reparar(base, comodoId);
}

/**
 * O rendimento do Empreendimento: teste de Inteligência com bônus igual à
 * capacidade de cômodos, rolado na mesa. O módulo anexa a rolagem ao card,
 * então ela vai como uma Roll sem dados — "d20 da mesa + bônus" —, que dá
 * sempre o mesmo total e mostra a conta no chat.
 */
export async function apurarEmpreendimento(actor, user, { baseId, d20, dedicado = false } = {}) {
  const { Operacoes, lerBase } = exigirApi();
  const base = baseAdministrada(actor, user, baseId);
  const leitura = lerBase(base);
  const empreendimento = empreendimentoDe(leitura, actor);

  if (!empreendimento) throw new Error(`${base.name} não é um Empreendimento.`);
  if (empreendimento.modo === "negocio") {
    throw new Error("Nesta mesa o Empreendimento rende como negócio — use a tela de Negócios.");
  }
  if (!empreendimento.podeRolar) throw new Error(`${actor.name} não mora em ${base.name}.`);

  const dado = Math.floor(Number(d20));
  if (!Number.isFinite(dado) || dado < 1 || dado > 20) {
    throw new Error("O resultado do d20 precisa ser um número de 1 a 20.");
  }

  const parcela = (n) => (n < 0 ? ` - ${Math.abs(n)}` : ` + ${n}`);
  const formula = `${dado}${parcela(empreendimento.bonusInteligencia)}${parcela(empreendimento.bonusCapacidade)}`;
  const roll = await new Roll(formula).evaluate();
  return Operacoes.apurarEmpreendimento(base, { roll, actor, dedicado: !!dedicado });
}
