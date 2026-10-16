# 📄 PDF Studio — Editor de PDF no navegador (SPA)

Editor/gerenciador de PDF **100% client-side** (nenhum backend, nada é enviado para
servidores). Feito com HTML5 + Tailwind CSS (CDN) + JavaScript puro (ES6+) e otimizado
para uso com dedo/caneta em **tablets** (alvos de toque de 44px, `touch-action` correto,
funcionamento offline após o cache do CDN).

## Funcionalidades

- 📂 Abrir PDF por **drag & drop** ou seletor de arquivos
- 🖼 Miniaturas em grade com **seleção múltipla** (caixa ✓) e página ativa destacada
- 🗑 **Excluir** páginas selecionadas (ou marcar todas de uma vez)
- ◀ ▶ **Reordenar** páginas (botões no tablet, arrastar no desktop)
- ↺ ↻ **Girar** páginas 90° (os elementos sobrepostos giram junto)
- ✏ **Caixas de texto** sobrepostas: arrastar, redimensionar, editar (duplo clique),
  tamanho, cor e negrito
- ✍ **Assinatura**: desenhar no canvas (fundo transparente, com recorte automático)
  ou enviar PNG/JPG — depois arrastar/redimensionar sobre a página
- ⤓ **Exportar** o PDF final com `pdf-lib` e baixar direto no dispositivo

## Arquivos

| Arquivo      | Descrição                                              |
|--------------|--------------------------------------------------------|
| `index.html` | Estrutura da SPA + dependências via CDN                 |
| `styles.css` | Estilos personalizados (Modo Escuro, toque, modais)     |
| `app.js`     | Toda a lógica: renderização, edição e exportação       |

## Bibliotecas (CDN)

- [PDF.js](https://mozilla.github.io/pdf.js/) `3.11.174` — renderização das páginas
- [pdf-lib](https://pdf-lib.js.org/) `1.17.174` — manipulação/exportação
- [interact.js](https://interactjs.io/) `1.10.27` — arrastar/redimensionar elementos
- [Tailwind CSS](https://tailwindcss.com/) (CDN, uso em desenvolvimento)

## ▶ Como executar localmente

Basta servir a pasta por HTTP (não recomendado abrir via `file://`, pois o *web worker*
do PDF.js pode ser bloqueado):

```bash
cd pdf-studio

# opção 1: Python
python3 -m http.server 8080

# opção 2: Node
npx serve .

# opção 3: PHP
php -S localhost:8080
```

Depois abra <http://localhost:8080> no navegador (desktop, tablet ou celular na mesma rede).

## ☁ Publicação gratuita

### GitHub Pages
1. Crie um repositório e envie os arquivos:
   ```bash
   git init
   git add .
   git commit -m "PDF Studio"
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/pdf-studio.git
   git push -u origin main
   ```
2. No GitHub: **Settings → Pages → Branch: main → / (root) → Save**.
3. O site ficará em `https://SEU_USUARIO.github.io/pdf-studio/`.

### Vercel
1. Crie conta em <https://vercel.com> (plano gratuito).
2. **Add New → Project** → importe o repositório (não precisa de framework nenhum).
3. Deploy com um clique — funciona com build command vazio e output = raiz.

> Dica para tablet: após abrir a URL, use **“Adicionar à tela inicial”** para abrir
> o editor como se fosse um app.

## 🧠 Notas técnicas

- O arquivo original nunca sai do navegador; cada cópia dos bytes é feita porque o
  PDF.js pode "transferir" (detached) o `ArrayBuffer` para o *web worker*.
- As posições de textos/assinaturas são guardadas em **pontos PDF** (unidades do
  documento), não em pixels — assim o export é idêntico em qualquer tela/resolução.
- O export mapeia cada elemento para o sistema de coordenadas do `MediaBox`
  considerando a rotação total da página (`/Rotate` original + rotações do usuário),
  garantindo texto e imagens corretamente orientados e posicionados.
- Fontes padrão `Helvetica` / `HelveticaBold` (sem necessidade de embutir fontes).

## Limitações conhecidas

- Reordenação por arrastar usa HTML5 Drag & Drop (desktop); em telas sensíveis ao
  toque use os botões ◀ ▶ (mais confiáveis e maiores).
- Textos são exportados com fontes padrão; caracteres fora do WinAnsi (ex.: emojis)
  não são suportados na fonte padrão.
- Arquivos PDF com senha/criptografia não são suportados.
