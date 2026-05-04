/* ═══════════════════════════════════════════════════════════
   Portal de Transparência — Faculdade de Economia
   app.js — Dados, parsing, gráficos e renderização
═══════════════════════════════════════════════════════════ */

// ─── CONFIGURAÇÃO ────────────────────────────────────────────
const CONFIG = {
  TITULO:   'Faculdade de Economia — UFMT',
  SEMESTRE: '2026/1',

  // URLs das abas publicadas como CSV
  SHEET_PGA:  'https://docs.google.com/spreadsheets/d/e/2PACX-1vQwugxW7o-kD4DHOtW-4cmc8UbXh8f0prF8bykqFoW4hBTMkn39JteFl7ho8krPnBGU_J2FEsN-hyLt/pub?gid=0&single=true&output=csv',
  SHEET_MIAR: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQwugxW7o-kD4DHOtW-4cmc8UbXh8f0prF8bykqFoW4hBTMkn39JteFl7ho8krPnBGU_J2FEsN-hyLt/pub?gid=844388114&single=true&output=csv',

  // Paleta de cores para gráficos
  CORES_PGA_RECEITA: ['#2ecc71', '#1abc9c'],
  CORES_PGA_DESPESA: ['#e74c3c', '#c0392b', '#e67e22', '#f39c12', '#d35400'],
  CORES_MIAR:        ['#3498db', '#9b59b6', '#2ecc71', '#e67e22'],
};

// ─── ESTADO ──────────────────────────────────────────────────
let pgaData  = null;
let miarData = null;
const chartsReady = { 'visao-geral': false, pga: false, miar: false };
const chartInstances = {};

// ═══════════════════════════════════════════════════════════
// FETCH
// ═══════════════════════════════════════════════════════════

async function fetchCSV(url) {
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`Falha ao buscar CSV: HTTP ${resp.status}`);
  return resp.text();
}

// ═══════════════════════════════════════════════════════════
// PARSING CSV
// ═══════════════════════════════════════════════════════════

/**
 * Divide uma linha CSV respeitando campos entre aspas.
 */
function splitCSVLine(line) {
  const cols = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cols.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cols.push(current.trim());
  return cols;
}

/**
 * Converte string no formato brasileiro (1.234,56 ou -1.234,56) para Number.
 */
function parseBRL(str) {
  if (!str || str === '' || str === '-') return 0;
  const clean = str.replace(/\./g, '').replace(',', '.');
  return parseFloat(clean) || 0;
}

/**
 * Faz o parse da aba PGA.
 *
 * Estrutura esperada:
 *   Bloco 1 — cabeçalho "Rubrica,Total" + linhas de rubricas
 *   Linhas vazias (separador)
 *   Bloco 2 — "Resumo financeiro:" + cabeçalho "Item,Valor (R$)" + linhas de resumo
 */
function parsePGA(csv) {
  const lines = csv.split('\n').map(l => l.replace(/\r/g, ''));
  const rubricas = [];
  const resumo   = {};

  // Máquina de estados: header → rubricas → separador → resumo_header → resumo
  let estado = 'header';

  for (const line of lines) {
    const cols = splitCSVLine(line);
    const c0   = cols[0]?.trim() ?? '';
    const c1   = cols[1]?.trim() ?? '';

    switch (estado) {

      case 'header':
        // Pula linha de cabeçalho "Rubrica,Total"
        if (c0.toLowerCase().includes('rubrica')) { estado = 'rubricas'; }
        break;

      case 'rubricas':
        if (!c0) { estado = 'separador'; break; }
        const total = parseBRL(c1);
        rubricas.push({
          rubrica: c0,
          total,
          tipo: total >= 0 ? 'receita' : 'despesa',
        });
        break;

      case 'separador':
        // Ignora linhas vazias; detecta início do bloco de resumo
        if (c0.toLowerCase().includes('resumo')) { estado = 'resumo_header'; }
        break;

      case 'resumo_header':
        // Pula linha "Item, Valor (R$)"
        if (c0.toLowerCase() === 'item') { estado = 'resumo'; }
        break;

      case 'resumo':
        if (!c0) break;
        resumo[c0] = parseBRL(c1);
        break;
    }
  }

  // KPIs derivados
  const totalReceitas   = rubricas
    .filter(r => r.tipo === 'receita')
    .reduce((s, r) => s + r.total, 0);

  const totalDespesas   = Math.abs(rubricas
    .filter(r => r.tipo === 'despesa')
    .reduce((s, r) => s + r.total, 0));

  const saldoDisponivel = resumo['Saldo disponível']
    ?? resumo['saldo disponível']
    ?? resumo['Saldo Disponível']
    ?? 0;

  return { rubricas, resumo, totalReceitas, totalDespesas, saldoDisponivel };
}

/**
 * Faz o parse da aba MIAR.
 *
 * Estrutura: Rubrica,Valor — linha "Total" separada ao final.
 */
function parseMIAR(csv) {
  const lines = csv.split('\n').map(l => l.replace(/\r/g, ''));
  const categorias = [];
  let   total      = 0;
  let   isHeader   = true;

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols   = splitCSVLine(line);
    const rubrica = cols[0]?.trim() ?? '';
    const valor   = parseBRL(cols[1]);

    if (isHeader) { isHeader = false; continue; }
    if (!rubrica)  continue;

    if (rubrica.toLowerCase() === 'total') {
      total = valor;
    } else {
      categorias.push({ rubrica, valor });
    }
  }

  // Garante total mesmo se não houver linha "Total" na planilha
  if (!total) total = categorias.reduce((s, c) => s + c.valor, 0);

  return { categorias, total };
}

// ═══════════════════════════════════════════════════════════
// FORMATAÇÃO
// ═══════════════════════════════════════════════════════════

function formatBRL(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency: 'BRL',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(value);
}

const tooltipLabel = ctx => ` ${formatBRL(Math.abs(ctx.raw))}`;

// ═══════════════════════════════════════════════════════════
// KPI CARDS
// ═══════════════════════════════════════════════════════════

function renderKPIs() {
  // Visão Geral
  set('kpi-receitas',     formatBRL(pgaData.totalReceitas));
  set('kpi-despesas',     formatBRL(pgaData.totalDespesas));
  set('kpi-saldo',        formatBRL(pgaData.saldoDisponivel));
  set('kpi-miar-total',   formatBRL(miarData.total));

  // PGA
  set('kpi-pga-receitas', formatBRL(pgaData.totalReceitas));
  set('kpi-pga-despesas', formatBRL(pgaData.totalDespesas));
  set('kpi-pga-saldo',    formatBRL(pgaData.saldoDisponivel));

  // MIAR
  set('kpi-miar-total-2', formatBRL(miarData.total));
}

function set(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ═══════════════════════════════════════════════════════════
// TABELAS
// ═══════════════════════════════════════════════════════════

function renderTabelaPGA() {
  const rows = pgaData.rubricas.map(r => `
    <tr>
      <td>${r.rubrica}</td>
      <td class="val-${r.tipo}">${formatBRL(r.total)}</td>
      <td><span class="badge badge--${r.tipo}">${r.tipo === 'receita' ? 'Receita' : 'Despesa'}</span></td>
    </tr>`).join('');

  document.getElementById('tabela-pga').innerHTML = `
    <thead><tr><th>Rubrica</th><th>Valor</th><th>Tipo</th></tr></thead>
    <tbody>${rows}</tbody>`;
}

function renderTabelaResumo() {
  const rows = Object.entries(pgaData.resumo).map(([item, valor]) => {
    const isSaldo = item.toLowerCase().includes('saldo');
    return `<tr ${isSaldo ? 'class="row-destaque"' : ''}>
      <td>${item}</td>
      <td>${formatBRL(valor)}</td>
    </tr>`;
  }).join('');

  document.getElementById('tabela-pga-resumo').innerHTML = `
    <thead><tr><th>Item</th><th>Valor</th></tr></thead>
    <tbody>${rows}</tbody>`;
}

function renderTabelaMIAR() {
  const rows = miarData.categorias.map(c => `
    <tr><td>${c.rubrica}</td><td>${formatBRL(c.valor)}</td></tr>`).join('');

  document.getElementById('tabela-miar').innerHTML = `
    <thead><tr><th>Categoria</th><th>Valor</th></tr></thead>
    <tbody>
      ${rows}
      <tr class="row-total">
        <td><strong>Total</strong></td>
        <td><strong>${formatBRL(miarData.total)}</strong></td>
      </tr>
    </tbody>`;
}

// ═══════════════════════════════════════════════════════════
// GRÁFICOS (criados de forma lazy ao exibir a aba)
// ═══════════════════════════════════════════════════════════

const LEGEND_OPTS = {
  labels: {
    color: '#e8eaf0',
    font:  { family: 'Inter', size: 12 },
    padding: 14,
    boxWidth: 14,
  },
  position: 'bottom',
};

// Destrói instância anterior se existir
function destroyChart(key) {
  if (chartInstances[key]) { chartInstances[key].destroy(); delete chartInstances[key]; }
}

// ── Rosca PGA (Visão Geral) ──────────────────────────────────
function buildPGARosca() {
  destroyChart('pgaRosca');

  let ri = 0, di = 0;
  const labels = pgaData.rubricas.map(r => r.rubrica);
  const data   = pgaData.rubricas.map(r => Math.abs(r.total));
  const colors = pgaData.rubricas.map(r =>
    r.tipo === 'receita'
      ? CONFIG.CORES_PGA_RECEITA[ri++ % CONFIG.CORES_PGA_RECEITA.length]
      : CONFIG.CORES_PGA_DESPESA[di++ % CONFIG.CORES_PGA_DESPESA.length]
  );

  chartInstances.pgaRosca = new Chart(
    document.getElementById('chart-pga-rosca'),
    {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data, backgroundColor: colors, borderColor: '#0a1628', borderWidth: 2 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: LEGEND_OPTS,
          tooltip: { callbacks: { label: tooltipLabel } },
        },
      },
    }
  );
}

// ── Barras horizontais PGA ────────────────────────────────────
function buildPGABarras() {
  destroyChart('pgaBarras');

  const labels = pgaData.rubricas.map(r => r.rubrica);
  const data   = pgaData.rubricas.map(r => Math.abs(r.total));
  const colors = pgaData.rubricas.map(r =>
    r.tipo === 'receita' ? '#2ecc71' : '#e74c3c'
  );

  chartInstances.pgaBarras = new Chart(
    document.getElementById('chart-pga-barras'),
    {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Valor (R$)',
          data,
          backgroundColor: colors,
          borderColor:      colors,
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` ${formatBRL(ctx.raw)}`,
            },
          },
        },
        scales: {
          x: {
            ticks: {
              color: '#8892a4',
              font:  { family: 'Inter', size: 11 },
              callback: v => `R$ ${(v / 1000).toFixed(0)}k`,
            },
            grid: { color: 'rgba(255,255,255,0.05)' },
          },
          y: {
            ticks: {
              color: '#e8eaf0',
              font:  { family: 'Inter', size: 11 },
            },
            grid: { display: false },
          },
        },
      },
    }
  );
}

// ── Pizza MIAR (reutilizável para os dois canvas) ─────────────
function buildMIARPizza(canvasId, chartKey) {
  destroyChart(chartKey);

  const labels = miarData.categorias.map(c => c.rubrica);
  const data   = miarData.categorias.map(c => c.valor);

  chartInstances[chartKey] = new Chart(
    document.getElementById(canvasId),
    {
      type: 'pie',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: CONFIG.CORES_MIAR,
          borderColor:     '#0a1628',
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: LEGEND_OPTS,
          tooltip: { callbacks: { label: tooltipLabel } },
        },
      },
    }
  );
}

// ── Criação lazy por aba ──────────────────────────────────────
function buildChartsForTab(tab) {
  if (chartsReady[tab]) return;
  chartsReady[tab] = true;

  if (tab === 'visao-geral') {
    buildPGARosca();
    buildMIARPizza('chart-miar-pizza', 'miarPizzaGeral');
  }
  if (tab === 'pga') {
    buildPGABarras();
  }
  if (tab === 'miar') {
    buildMIARPizza('chart-miar-pizza-2', 'miarPizzaMIAR');
  }
}

// ═══════════════════════════════════════════════════════════
// NAVEGAÇÃO POR ABAS
// ═══════════════════════════════════════════════════════════

function activateTab(tab) {
  // Atualiza botões
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive);
  });

  // Exibe seção correta
  document.querySelectorAll('.tab-section').forEach(sec => {
    sec.style.display = 'none';
  });
  const section = document.getElementById(`tab-${tab}`);
  if (section) section.style.display = 'block';

  // Cria gráficos da aba se ainda não foram criados
  if (pgaData && miarData) buildChartsForTab(tab);
}

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });
}

// ═══════════════════════════════════════════════════════════
// INICIALIZAÇÃO
// ═══════════════════════════════════════════════════════════

async function init() {
  // Preenche textos configuráveis
  set('titulo-faculdade', CONFIG.TITULO);
  set('badge-semestre',   CONFIG.SEMESTRE);
  set('footer-nome',      CONFIG.TITULO);
  set('footer-semestre',  CONFIG.SEMESTRE);

  initTabs();

  try {
    // Busca os dois CSVs em paralelo
    const [csvPGA, csvMIAR] = await Promise.all([
      fetchCSV(CONFIG.SHEET_PGA),
      fetchCSV(CONFIG.SHEET_MIAR),
    ]);

    pgaData  = parsePGA(csvPGA);
    miarData = parseMIAR(csvMIAR);

    // Esconde loading e mostra conteúdo
    document.getElementById('loading').style.display = 'none';
    activateTab('visao-geral');

    // Atualiza indicador de data
    const agora = new Date().toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    set('ultima-atualizacao', `Atualizado: ${agora}`);

    // Renderiza KPIs e tabelas (não dependem de visibilidade)
    renderKPIs();
    renderTabelaPGA();
    renderTabelaResumo();
    renderTabelaMIAR();

  } catch (err) {
    console.error('[Portal FE]', err);
    document.getElementById('loading').style.display = 'none';
    document.getElementById('erro').style.display = 'block';
  }
}

document.addEventListener('DOMContentLoaded', init);
