# pauta

Editor de texto colaborativo que funciona sem internet. Várias pessoas escrevem e formatam o mesmo documento ao mesmo tempo, cada uma na sua cópia, e as cópias se juntam sozinhas: letra por letra, negrito por negrito, sem tela de conflito.

Tudo o que faz isso funcionar foi escrito do zero: o CRDT de texto, a formatação por intervalos (no estilo do artigo [Peritext](https://www.inkandswitch.com/peritext/)), o protocolo de sincronização e o próprio editor. Não há Yjs, Automerge, ProseMirror nem Tiptap.

## O que tem

- **Texto rico em tempo real.** Títulos, listas, tarefas, citações, blocos de código, negrito, itálico, riscado, código e links.
- **Formatação que converge.** Uma pessoa põe um trecho em negrito enquanto outra escreve no meio dele: o texto novo sai em negrito nas duas cópias. Negrito e itálico sobrepostos se combinam. Aplicar e remover ao mesmo tempo tem um vencedor único.
- **Comentários ancorados no texto.** O comentário acompanha as palavras quando o texto em volta muda, tem respostas e pode ser resolvido.
- **Cursores e seleções dos outros,** com nome e cor, ancorados em letras e não em posições.
- **Offline de verdade.** Cada tecla é gravada no IndexedDB antes de ir para a rede. O "modo avião" corta a conexão de propósito para ver a fusão acontecer.
- **Desfazer por pessoa.** Ctrl+Z desfaz o que você fez, sem tocar no que os outros escreveram.
- **Histórico.** Uma régua volta o documento a qualquer ponto do passado, operação por operação.
- **Atalhos de Markdown** (`# `, `- `, `1. `, `> `, `[] `, ` ``` `) e exportação para `.md`.
- **Laboratório de conflitos.** Duas cópias lado a lado, um cabo que se tira e se põe, e cinco casos clássicos de edição concorrente prontos para rodar.

## Como rodar

Requisitos: [Go 1.26+](https://go.dev/dl/) e [Node 22+](https://nodejs.org/). Não precisa de Docker nem de banco externo.

```bat
run.bat
```

Abre em <http://127.0.0.1:7272>. Crie um documento e abra o mesmo endereço em outra aba, ou em outro navegador, para ver duas pessoas escrevendo.

| Comando | O que faz |
| --- | --- |
| `run.bat` | Compila o frontend, embute no binário e sobe o servidor |
| `run.bat -Dev` | Servidor + Vite com hot reload em <http://localhost:5179> |
| `run.bat -Test` | Testes do servidor (Go), do núcleo (vitest) e checagem de tipos |
| `run.bat -Port 8080 -NoBrowser` | Outra porta, sem abrir o navegador |

O laboratório fica em <http://127.0.0.1:7272/lab> e não precisa do servidor para nada: as duas cópias vivem na mesma página.

## Como funciona

### Três CRDTs, um log

Tudo o que alguém faz vira uma **operação** com identidade própria (um relógio de Lamport mais o id da réplica). Réplicas que aplicaram o mesmo conjunto de operações, em qualquer ordem, mostram o mesmo documento.

| Parte | Estrutura | Operação |
| --- | --- | --- |
| Texto | Sequência (RGA): cada caractere tem um id e lembra depois de qual foi digitado | `ins`, `rem` |
| Formatação | Conjunto de intervalos ancorados em caracteres | `mark` |
| Tipo de bloco, título, comentários | Registros em que a última escrita vence | `set` |

Um `"\n"` na sequência abre um bloco, e o id dele é o nome do bloco: é nele que ficam o tipo (título, lista…) e a marcação de tarefa concluída. Apagar a quebra de linha junta os dois blocos, e o de cima mantém o tipo.

### Formatação por intervalos

Guardar "negrito da posição 2 à 8" não sobrevive a edições concorrentes: as posições mudam. Aqui um intervalo guarda **os ids dos caracteres** das pontas:

```
A  r a p o s a  p u l o u
   └─────────┘
   de: antes de "r"      até: antes do " " seguinte
```

- O fim de um negrito é "antes do caractere seguinte". O que for digitado na ponta entra antes desse caractere, logo dentro do intervalo: o negrito **cresce** com o texto.
- O fim de um link ou comentário é "depois do último caractere". O que for digitado na ponta fica **fora**.
- Caracteres apagados continuam na sequência como lápides, então um intervalo cujas pontas foram apagadas ainda sabe onde está.

Para desenhar, o documento é varrido uma vez: os intervalos abrem e fecham nos índices dos elementos, e em cada caractere vale, para cada tipo de formato, o intervalo de **maior id** entre os que o cobrem. Remover um formato é só mais um intervalo, com valor falso. Como a regra só olha ids, a ordem de chegada não importa.

### O editor

O editor é um `contenteditable` em que **o navegador nunca edita nada**. Cada tecla chega como um evento `beforeinput`, é cancelada e vira um comando sobre o CRDT; o React redesenha a partir do documento e a seleção é recolocada. Assim uma edição remota e uma local passam exatamente pelo mesmo caminho, e o DOM é sempre função do documento.

A exceção é a composição de texto (acentos com tecla morta, teclados de outros idiomas), que não pode ser cancelada: o navegador mexe no DOM, e ao terminar o bloco é comparado com o documento e a diferença é aplicada.

A seleção é guardada como ids de caracteres. Se alguém escreve antes do seu cursor, ele continua no mesmo lugar do texto, e é isso que é enviado aos outros para desenhar o seu cursor na tela deles.

Os comandos de edição (`ui/core/edit.ts`) são funções puras sobre o documento e uma seleção, testadas sem navegador.

### Sincronização

```
edição local ──► documento ──► IndexedDB            (sempre)
                    ├────────► outras abas          (BroadcastChannel, funciona offline)
                    └────────► servidor ──► pessoas (WebSocket, quando houver)
```

O servidor (Go, um binário com o frontend embutido) não interpreta operações: guarda o log de cada documento em SQLite e devolve a cada cliente o que falta. Ao conectar, o cliente manda seu vetor de versões; o servidor responde com as operações que ele não viu e com o próprio vetor, para o cliente enviar o que fez offline. Lacunas e repetições são tratadas: uma operação repetida é ignorada, uma fora de ordem espera no buffer do cliente até chegar o que ela referencia.

### Desfazer

Num documento compartilhado, "voltar ao estado anterior" apagaria o trabalho dos outros. O desfazer aqui emite operações novas que cancelam as suas: uma inserção é desfeita apagando exatamente aqueles caracteres; um apagamento, digitando-os de novo no mesmo lugar; um formato, com o intervalo oposto.

## Estrutura

```
cmd/pauta/            ponto de entrada do servidor
internal/store/       log de operações em SQLite
internal/hub/         protocolo de sincronização e presença
internal/server/      WebSocket, API e frontend embutido
ui/core/              o documento replicado, sem React e sem rede
  seq.ts              sequência (RGA)
  doc.ts              texto + intervalos de formato + registros
  edit.ts             comandos de edição
  undo.ts             desfazer por pessoa
  comments.ts         conversas ancoradas no texto
  markdown.ts         exportação
ui/src/components/    Editor, barra de ferramentas, comentários
ui/src/lib/           sessão (rede, abas, IndexedDB)
ui/src/pages/         início, documento, laboratório
```

Stack: Go 1.26, SQLite ([modernc.org/sqlite](https://pkg.go.dev/modernc.org/sqlite)), [coder/websocket](https://github.com/coder/websocket), React 19, TypeScript 7, Vite 8, Tailwind CSS 4.

## Testes

```bat
run.bat -Test
```

- **25 testes do núcleo** (vitest): os casos de formatação concorrente do Peritext, formato que sobrevive ao apagamento das pontas, operação que chega antes do texto a que se refere, comandos de edição, desfazer, comentários, exportação, e um teste de convergência com três réplicas fazendo edições aleatórias entregues fora de ordem e repetidas, que também confere que reconstruir o documento a partir do log dá o mesmo resultado.
- **6 testes do servidor** (Go, por WebSocket contra um SQLite real): retransmissão e recuperação, repetições e lacunas, presença, sobrevivência a reinício, rejeição de entrada malformada e muitos escritores ao mesmo tempo.

O editor e a sincronização entre abas foram conferidos no navegador, mas não têm testes automatizados.

## Limites

- **Sem controle de acesso.** Quem tem o código do documento lê e escreve. Não use para nada privado.
- **O log só cresce.** Lápides e operações antigas nunca são compactadas, e o histórico inteiro é carregado ao abrir. Para documentos muito grandes isso pesa.
- **Custo por tecla proporcional ao tamanho.** A cada alteração o documento é varrido de ponta a ponta para montar os blocos. Confortável para textos de algumas dezenas de páginas, não para um livro.
- **Colar traz só texto puro.** A formatação de origem é descartada.
- **Blocos não se aninham.** Não há sublistas, tabelas nem imagens.
- **Tipo de bloco é última-escrita-vence.** Se duas pessoas mudam o tipo do mesmo bloco ao mesmo tempo, uma das escolhas se perde (as cópias continuam iguais).
- **Desfazer um apagamento recoloca o texto sem a formatação** que ele tinha, e comentários não entram no desfazer.
- **Composição de texto com uma seleção de vários blocos** ativa pode exigir um redesenho completo do documento.
- **Restaurar uma versão do histórico** não existe: a régua só mostra o passado.
- **Só foi testado em navegadores baseados em Chromium.**

## Licença

MIT. Veja [LICENSE](LICENSE).
