# Arton de Bolso

Módulo do FoundryVTT (sistema `tormenta20`) — e **só o módulo**: nenhum
front-end mora nesta pasta. Ele transforma o Foundry num **relay** para o
front-end web standalone (projeto irmão
[`../arton-de-bolso-frontend/`](../arton-de-bolso-frontend/), hospedado à
parte, ex: numa VPS): o jogador abre o front no navegador, loga com o
próprio usuário do Foundry, e vê uma ficha simplificada que se atualiza em
tempo real — tudo sem tocar no mapa/UI completa do Foundry. Ver
[`../docs/arquitetura.md`](../docs/arquitetura.md) para o histórico da
decisão (o projeto já passou por dois pivôs de arquitetura).

## Princípio central: nunca rola dados

Os dados são sempre rolados **fisicamente, na mesa**. O módulo nunca chama
`actor.rollPericia`, `actor.rollAtributo` ou `item.roll()`, e nunca escreve
no chat. Onde um teste precisaria ser rolado, o front mostra a **fórmula
decomposta**, explicando de onde vem cada parte, para o jogador rolar o dado
físico e somar de cabeça.

## Como funciona (visão geral)

Um módulo Foundry só executa dentro de um client já carregado — não existe
"servidor" nosso ouvindo porta nenhuma. O que existe é o canal de socket
custom do próprio Foundry (`"socket": true` no `module.json` → evento
`module.arton-de-bolso`): qualquer socket autenticado — inclusive uma
conexão que não seja um client Foundry completo, como o front standalone —
pode emitir e receber nesse canal, desde que tenha feito o mesmo handshake
de sessão que um client real faz (`POST /join` com usuário/senha, depois
conectar o socket.io passando a sessão).

- **[`scripts/relay.mjs`](scripts/relay.mjs)** só age dentro do client do
  **mestre** (`game.user.isGM`) — é ele quem precisa estar com o Foundry
  aberto pro relay funcionar. Escuta pedidos do front (`obterPersonagens`,
  `obterFicha`, `selecionarPersonagem`, `ajustarPV`, `alternarEquipado`,
  etc.), aplica usando os métodos do sistema (ver tabela abaixo) e
  retransmite só para o usuário que tem direito de ver aquele Actor — nunca
  para os outros. Também escuta `Hooks` (`updateActor`/`*Item`) para
  empurrar a ficha nova mesmo quando a mudança vem de o mestre editando a
  ficha direto no Foundry.

  A permissão nativa de Ownership do Foundry define os dois grupos que a
  home do front mostra:

  | Permissão no Actor | Onde aparece | O que pode fazer |
  |---|---|---|
  | **Owner** | "Meus Personagens" | Ler e escrever (PV, PM, itens, dinheiro, descanso) |
  | **Observer** (sem Owner) | "Companheiros" | Só ler — a ficha chega com `somenteLeitura: true` e toda escrita é recusada pelo relay |

  `somenteLeitura` é só uma dica de UI: quem autoriza de verdade é o
  `testUserPermission(user, "OWNER")` que o relay refaz antes de cada
  escrita, com o `userId` que o próprio servidor do Foundry carimba na
  mensagem.
- **[`scripts/diarios.mjs`](scripts/diarios.mjs)** e
  **[`scripts/compendio.mjs`](scripts/compendio.mjs)** cuidam das **anotações
  dos jogadores** e do **compêndio** — ver as seções próprias abaixo. São os
  únicos arquivos que falam com `JournalEntry`/`Folder`.
- **[`scripts/adaptador-tormenta20.mjs`](scripts/adaptador-tormenta20.mjs)**
  é o único arquivo que conhece os caminhos de `actor.system.*`/
  `item.system.*` — os caminhos foram confirmados lendo o código-fonte do
  sistema `tormenta20` instalado (não só inspecionando um personagem ao
  vivo), incluindo a mesma lógica que a própria ficha do sistema usa pra
  montar o tooltip de PV/PM/Defesa/Perícia.
- O front-end (UI, telas) mora inteiramente em
  [`../arton-de-bolso-frontend/`](../arton-de-bolso-frontend/) — projeto
  Node/Next.js separado, com deploy próprio. Nada dele mora aqui, e este
  módulo não tem UI própria dentro do Foundry — é só o relay.

## Ações — sempre via método do sistema, nunca escrevendo o campo direto

| Ação | Chamada |
|---|---|
| Dano em PV | `actor.applyDamage(quantidade, 1, false)` — já cuida de descontar do PV temporário primeiro |
| Cura de PV | `actor.applyDamage(-quantidade, 1, false)` |
| Gastar PM | `actor.spendMana(quantidade, 0, false)` |
| Recuperar PM | `actor.spendMana(quantidade, 0, true)` |
| Equipar/desequipar | `item.update({ "system.equipado": !equipadoAtual })` |
| Ajustar moeda | `actor.update({ "system.dinheiro.<tc\|tl\|to\|tp>": novoValor })` |
| Ativar poder / conjurar / usar item | `gastarUso` — desconta PM e unidades de item, e anuncia no chat |

Reaproveitar os métodos do sistema em vez de escrever direto em
`system.attributes.pv.value` evita duplicar a lógica de clamp/temp que o
sistema já resolve corretamente (confirmado lendo o código-fonte).

**Moedas**: os nomes dos campos não seguem a sigla do metal (inconsistência
do próprio sistema `tormenta20`, confirmada lendo `schemaCurrency`) —
`tc`=Cobre, `tl`=Platina, `to`=Ouro, `tp`=Prata.

**`equipado`**: `boolean` em itens `equipamento`, `number` (0/1/2) em itens
`arma` — o adaptador lê sempre via `!!item.system.equipado` e grava um
`boolean` (o `NumberField` da arma converte automaticamente).

## Tags de poder (`system.rolltags`)

Duas tags que o mestre escreve no poder mudam como o app o mostra:

| Tag | O que faz |
|---|---|
| `lvl-06` | Nível em que o poder foi ganho — agrupa a lista ("Nível 6"). Sem ela, o poder entra em "Base" (raça, origem, divindade) |
| `ativo` | O poder ganha o botão **Ativar**: cobra o custo em PM/itens, liga na ficha os Active Effects do poder e publica o card do sistema no chat. Sem ela é passiva: só o texto |

Ativar é uma coisa só, do lado do jogador, e três do lado do Foundry: o gasto
(com os aprimoramentos marcados na conta), os efeitos ligados na ficha — Fúria,
Frenesi e afins, com a duração convertida da duração do poder, renovando em vez
de empilhar — e o card nativo (`displayCard`) na mesa, com os botões de aplicar
o efeito em outros alvos. O card sai **sem rolar dado nenhum** e sem o botão de
gastar PM, porque o app já cobrou; o gasto vira o `flavor` da mensagem.

`ativo` é decisão do mestre de propósito. Uma heurística nossa — "tem execução
declarada", "cobra PM" — erraria nos dois sentidos: no compêndio há passiva
com execução preenchida e poder de usar que não cobra nada.

## Perícias — fórmula decomposta, sem rolar

Cada perícia decompõe em: modificador do atributo, bônus de treino
(`system.attributes.treino`, só se `.treinado`; tabela +2/+4/+6 por nível
confirmada no código-fonte), `.outros` e `.condi`. Qualquer diferença entre
essa soma e o `.value` total (penalidade de armadura, modificador de
tamanho, efeitos ativos) entra como uma linha final "Outros efeitos" — nunca
é descartada.

## Anotações dos jogadores

Uma pasta **"Anotações Jogadores"** com um `JournalEntry` por jogador, criada
sozinha quando o mestre abre o mundo (e, para quem entrar depois, na primeira
visita à tela). Cada anotação é uma página de texto do journal.

| Diário | Ownership | O que o jogador faz |
|---|---|---|
| O dele | `OWNER` (e `default: OBSERVER`) | Cria, edita, renomeia e apaga anotações |
| Dos colegas | `OBSERVER` | Só lê |

É a permissão nativa do Foundry, então o mestre vê tudo, pode reorganizar
pela interface dele e o conteúdo entra no backup do mundo. Como nas fichas, o
relay refaz o `testUserPermission` antes de escrever — e resolve a página
**dentro** do diário de quem pediu, de forma que o id de uma página alheia não
encontra documento nenhum.

A anotação é **texto formatado** (negrito, itálico, listas), e tudo que entra
ou sai passa por [`scripts/html-seguro.mjs`](scripts/html-seguro.mjs), que
reduz o HTML a uma allowlist de tags e atributos. Sem essa poda, um jogador
poderia gravar `<script>` no próprio diário e executá-lo no navegador de quem
lesse — o do mestre inclusive, que é quem roda o relay. Imagem dentro do texto
não passa: o app não tem por onde subir arquivo, e prop com imagem é assunto
da seção seguinte.

Se o mestre já tiver criado à mão um journal com o nome do jogador dentro
dessa pasta, o módulo **adota** esse (marcando-o com a flag `donoId`) em vez
de criar um segundo.

## Compêndio — o material que o mestre libera

A pasta **"Conteúdos Para Jogadores"** (criada junto com a de anotações) e
quantas subpastas o mestre quiser dentro dela — retratos de NPC, regras
específicas da mesa, cartas e o que mais ele quiser deixar à mão do grupo. O app navega essa árvore como
ela é, e o **journal conta como mais um nível**: quem abre e vê é a *página* —
a carta, o retrato, o mapa. Um journal de uma página só leva direto a ela.

**Liberar algo é dar Observador no journal** — não há passo de publicação no
app. O journal nasce invisível, aparece na tela de quem recebeu a permissão e
some de novo quando ela é tirada, com a tela do jogador acompanhando ao vivo.

Só páginas de **texto** (formatado, mesma peneira das anotações) e de
**imagem** (com legenda). Vídeo, PDF e os demais tipos ficam de fora, e um
journal — ou uma pasta — que não sobre nada visível nem entra na lista.

A pasta é procurada **ignorando acentos e caixa**: uma versão anterior do
módulo a criou como "Conteudos Para Jogadores", e achar as duas grafias evita
o mundo terminar com duas pastas quase iguais (a antiga é renomeada para a
forma com acento).

## Como instalar / atualizar

O Foundry carrega o módulo de `Data/modules/arton-de-bolso/`, não desta
pasta — **editar aqui não muda nada no jogo até copiar**. Use o script:

```bash
./deploy.sh            # copia o que estiver diferente
./deploy.sh --check    # só relata divergências (sai 1 se houver)
./deploy.sh --watch    # copia sozinho a cada mudança, enquanto você trabalha
./deploy.sh --prune    # copia e apaga no destino o que não existe mais aqui
```

Ele acha a pasta `Data` sozinho; se não achar, aponte com
`FOUNDRY_DATA=/caminho/para/Data ./deploy.sh` ou grave o caminho em
`.foundry-data` (não versionado).

**Não dá pra usar symlink** neste setup: o Foundry roda no Windows nativo e
um link criado pelo WSL dentro de `/mnt/c` é um reparse point que o Windows
não resolve — apontaria para o ext4 do WSL, invisível para o processo do
Foundry.

Depois de copiar, **dê F5 no client do mestre** — é ele que executa o relay,
e o módulo só recarrega junto com a página. Na primeira vez, ative o módulo
no mundo (Configurações do Mundo → Módulos). Sem backend nem processo
servidor nosso — autenticação é a sessão nativa do Foundry.

O deploy do front-end é independente — ver
[`../arton-de-bolso-frontend/README.md`](../arton-de-bolso-frontend/README.md).

## Pendências conhecidas (não bloqueantes)

1. **Múltiplos mestres conectados ao mesmo tempo**: cada um responderia às
   mensagens do front, podendo gerar respostas duplicadas (raro, não
   tratado).
2. **Deslocamento**: mostrado como valor único, sem decompor modificadores
   (raça, etc.) — o sistema não guarda esse breakdown de forma acessível.
