const $ = (selector, root = document) => root.querySelector(selector);
const main = $('#main-content');
const list = $('#workflow-list');
const login = $('#login-backdrop');
const toast = $('#toast');
const types = [
	['trigger.manual', 'Manual Trigger'],
	['trigger.webhook', 'Webhook Trigger'],
	['trigger.schedule', 'Schedule Trigger'],
	['data.set', 'Set Fields'],
	['http.request', 'HTTP Request'],
	['logic.if', 'If'],
];
let token = sessionStorage.getItem('squared-token') || '';
let workflows = [];
let current = null;
let toastTimer;

function notify(message) {
	toast.textContent = message;
	toast.classList.add('show');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

async function api(path, options = {}) {
	const response = await fetch(path, {
		...options,
		headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
	});
	const body = response.status === 204 ? null : await response.json();
	if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
	return body;
}

function element(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function button(label, className, action) {
	const node = element('button', className, label);
	node.type = 'button';
	node.addEventListener('click', action);
	return node;
}

function workflowTemplate() {
	return {
		name: 'Novo workflow',
		active: false,
		nodes: [
			{ id: crypto.randomUUID(), type: 'trigger.manual', name: 'Manual Trigger', parameters: {} },
			{ id: crypto.randomUUID(), type: 'data.set', name: 'Set Fields', parameters: { values: { message: 'Squared is ready' } } },
		],
	};
}

function renderNavigation() {
	list.replaceChildren();
	list.className = '';
	for (const workflow of workflows) {
		const item = button('', `workflow-nav${current?.id === workflow.id ? ' selected' : ''}`, () => openWorkflow(workflow.id));
		item.append(element('span', 'nav-glyph', '◇'), element('span', '', workflow.name));
		list.append(item);
	}
	if (workflows.length) {
		const credentials = button('', 'workflow-nav', () => openCredentials());
		credentials.append(element('span', 'nav-glyph', '⌑'), element('span', '', 'Credenciais'));
		list.append(credentials);
	}
}

async function refreshWorkflows() {
	workflows = await api('/api/workflows');
	renderNavigation();
	if (!current && workflows.length) await openWorkflow(workflows[0].id);
	if (!workflows.length) renderEmpty();
}

function renderEmpty() {
	current = null;
	main.replaceChildren();
	const state = element('section', 'empty-state');
	state.append(element('div', 'empty-icon', '◇'), element('h1', '', 'Crie seu primeiro workflow'));
	state.append(element('p', '', 'Combine gatilhos, dados e integrações em uma sequência de automação.'));
	state.append(button('Novo workflow', 'primary-button', createWorkflow));
	main.append(state);
	renderNavigation();
}

async function createWorkflow() {
	current = workflowTemplate();
	renderEditor();
}

async function openWorkflow(id) {
	try {
		current = await api(`/api/workflows/${encodeURIComponent(id)}`);
		renderNavigation();
		renderEditor();
	} catch (error) {
		notify(error.message);
	}
}

function renderEditor() {
	if (!current) return renderEmpty();
	main.replaceChildren();
	const head = element('div', 'editor-head');
	const titleBlock = element('div');
	titleBlock.append(element('p', 'eyebrow', 'WORKFLOW EDITOR'), element('h1', 'page-title', current.name || 'Novo workflow'));
	titleBlock.append(element('p', 'editor-description', 'Monte uma sequência de gatilho e ações para automatizar seu processo.'));
	const actions = element('div', 'actions');
	if (current.nodes[0]?.type === 'trigger.webhook' && current.id) {
		const url = element('span', 'code', `${location.origin}/webhook/${current.id}`);
		url.title = 'O endpoint exige o token de acesso da aplicação no cabeçalho Authorization';
		actions.append(url);
	}
	if (current.nodes[0]?.type === 'trigger.manual') actions.append(button('Executar', 'secondary-button', runWorkflow));
	if (current.nodes[0]?.type === 'trigger.webhook' && current.id) {
		actions.append(button('Testar webhook', 'secondary-button', fireWebhook));
	}
	actions.append(button('Salvar workflow', 'primary-button', saveWorkflow));
	head.append(titleBlock, actions);
	main.append(head);

	const overview = panel('Configuração', 'Workflow');
	const nameField = field('Nome do workflow', 'text');
	nameField.input.value = current.name;
	nameField.input.addEventListener('input', () => {
		current.name = nameField.input.value;
		$('.page-title', main).textContent = current.name || 'Novo workflow';
	});
	const meta = element('div', 'workflow-meta');
	const activeLabel = element('label', 'toggle-row');
	const active = document.createElement('input');
	active.type = 'checkbox';
	active.checked = current.active;
	active.disabled = current.nodes[0]?.type === 'trigger.manual';
	active.addEventListener('change', () => {
		current.active = active.checked;
	});
	activeLabel.append(active, element('span', '', active.disabled ? 'Gatilho manual' : 'Workflow ativo'));
	meta.append(activeLabel);
	overview.body.append(nameField.wrapper, meta);
	main.append(overview.root);

	const flowPanel = panel('Etapas', `${current.nodes.length} nós`);
	const flow = element('div', 'panel-body node-list');
	current.nodes.forEach((node, index) => {
		flow.append(renderNode(node, index));
		if (index < current.nodes.length - 1) flow.append(element('div', 'node-connector'));
	});
	const addRow = element('div', 'add-node-row');
	const addType = document.createElement('select');
	addType.className = 'select-input';
	for (const [type, label] of types.filter(([type]) => !type.startsWith('trigger.'))) {
		const option = document.createElement('option');
		option.value = type;
		option.textContent = label;
		addType.append(option);
	}
	addRow.append(addType, button('Adicionar nó', 'secondary-button', () => addNode(addType.value)));
	flow.append(addRow);
	flowPanel.body.replaceWith(flow);
	main.append(flowPanel.root);

	if (current.id) void renderExecutions();
}

function renderNode(node, index) {
	const wrap = element('div', 'node-wrap');
	const card = element('article', 'node-card');
	const top = element('div', 'node-top');
	const glyph = node.type.startsWith('trigger.') ? '⚡' : node.type === 'http.request' ? '↗' : node.type === 'logic.if' ? '⑂' : '✦';
	top.append(element('span', 'node-icon', glyph));
	const copy = element('div', 'node-top-copy');
	const title = document.createElement('strong');
	title.textContent = node.name;
	const subtitle = document.createElement('small');
	subtitle.textContent = types.find(([type]) => type === node.type)?.[1] || node.type;
	copy.append(title, subtitle);
	top.append(copy);
	if (index === 0) top.append(element('span', 'trigger-badge', 'Gatilho'));
	const tools = element('div', 'node-tools');
	if (index === 0) {
		const triggerSelect = document.createElement('select');
		triggerSelect.className = 'select-input';
		for (const [type, label] of types.filter(([type]) => type.startsWith('trigger.'))) {
			const option = document.createElement('option');
			option.value = type;
			option.textContent = label;
			triggerSelect.append(option);
		}
		triggerSelect.value = node.type;
		triggerSelect.addEventListener('change', () => {
			node.type = triggerSelect.value;
			node.name = types.find(([type]) => type === node.type)[1];
			node.parameters = node.type === 'trigger.schedule' ? { intervalSeconds: 60 } : {};
			if (node.type === 'trigger.manual') current.active = false;
			renderEditor();
		});
		tools.append(triggerSelect);
	} else {
		if (index > 1) tools.append(button('↑', 'quiet-button', () => moveNode(index, -1)));
		if (index < current.nodes.length - 1) tools.append(button('↓', 'quiet-button', () => moveNode(index, 1)));
		tools.append(button('×', 'quiet-button', () => removeNode(index)));
	}
	top.append(tools);
	const config = element('div', 'node-config');
	const json = document.createElement('textarea');
	json.className = 'json-input';
	json.spellcheck = false;
	json.value = JSON.stringify(node.parameters, null, 2);
	json.setAttribute('aria-label', `${node.name} parâmetros em JSON`);
	json.addEventListener('change', () => {
		try {
			const value = JSON.parse(json.value || '{}');
			if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Use um objeto JSON.');
			node.parameters = value;
			json.classList.remove('invalid');
		} catch (error) {
			json.classList.add('invalid');
			notify(error.message);
		}
	});
	config.append(json, element('p', 'node-help', helpFor(node.type)));
	card.append(top, config);
	wrap.append(card);
	return wrap;
}

function helpFor(type) {
	if (type === 'trigger.schedule') return 'Defina intervalSeconds entre 5 e 86400. Gatilhos agendados executam dentro da aplicação.';
	if (type === 'data.set') return 'Use values para definir campos. Expressões disponíveis: ={{$json.campo}}, ={{$execution.id}} e ={{$now}}.';
	if (type === 'http.request') return 'Use method, url, headers, body, credentialId e timeoutMs. Respostas acima de 5 MB são rejeitadas.';
	if (type === 'logic.if') return 'Defina value, operation (isTrue, equals, notEquals, greaterThan, contains, exists) e compareTo. Se falso, a sequência é encerrada.';
	if (type === 'trigger.webhook') return 'Envia um POST ao endereço exibido no topo. Inclua Authorization: Bearer <token da aplicação>.';
	return 'Inicie a execução manualmente pelo editor.';
}

function panel(title, subtitle) {
	const root = element('section', 'panel');
	const head = element('div', 'panel-head');
	head.append(element('h2', '', title), element('span', 'muted', subtitle));
	const body = element('div', 'panel-body');
	root.append(head, body);
	return { root, body };
}

function field(labelText, type) {
	const wrapper = element('div', 'field');
	const label = element('label', '', labelText);
	const input = document.createElement('input');
	input.type = type;
	input.className = 'text-input';
	label.append(input);
	wrapper.append(label);
	return { wrapper, input };
}

function addNode(type) {
	const label = types.find(([value]) => value === type)?.[1] || type;
	current.nodes.push({ id: crypto.randomUUID(), type, name: label, parameters: type === 'data.set' ? { values: {} } : {} });
	renderEditor();
}

function moveNode(index, direction) {
	const target = index + direction;
	if (target < 1 || target >= current.nodes.length) return;
	[current.nodes[index], current.nodes[target]] = [current.nodes[target], current.nodes[index]];
	renderEditor();
}

function removeNode(index) {
	current.nodes.splice(index, 1);
	renderEditor();
}

async function saveWorkflow() {
	try {
		const saved = current.id
			? await api(`/api/workflows/${encodeURIComponent(current.id)}`, { method: 'PUT', body: JSON.stringify(current) })
			: await api('/api/workflows', { method: 'POST', body: JSON.stringify(current) });
		current = saved;
		await refreshWorkflows();
		notify('Workflow salvo no PostgreSQL');
	} catch (error) {
		notify(error.message);
	}
}

async function runWorkflow() {
	if (!current.id) {
		notify('Salve o workflow antes de executar');
		return;
	}
	try {
		const queued = await api(`/api/workflows/${encodeURIComponent(current.id)}/run`, {
			method: 'POST', body: JSON.stringify({ input: {} }),
		});
		notify(`Execução ${queued.id.slice(0, 8)} enfileirada`);
		await renderExecutions();
		void waitForExecution(queued.id);
	} catch (error) {
		notify(error.message);
	}
}

async function fireWebhook() {
	try {
		const queued = await api(`/webhook/${encodeURIComponent(current.id)}`, {
			method: 'POST', body: JSON.stringify({ source: 'editor-test' }),
		});
		notify(`Webhook enfileirado: ${queued.id.slice(0, 8)}`);
		await renderExecutions();
		void waitForExecution(queued.id);
	} catch (error) {
		notify(error.message);
	}
}

async function waitForExecution(id) {
	for (let attempt = 0; attempt < 80; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 250));
		try {
			const execution = await api(`/api/executions/${encodeURIComponent(id)}`);
			if (['succeeded', 'failed', 'abandoned'].includes(execution.status)) {
				await renderExecutions();
				return;
			}
		} catch {
			return;
		}
	}
	await renderExecutions();
}

async function renderExecutions() {
	try {
		const all = await api('/api/executions?limit=20');
		const entries = all.filter((item) => item.workflowId === current?.id);
		const section = panel('Execuções recentes', `${entries.length} de 20`);
		if (!entries.length) {
			section.body.append(element('p', 'muted', 'As execuções deste workflow aparecerão aqui.'));
		} else {
			const table = element('table', 'table');
			const header = document.createElement('thead');
			const headerRow = document.createElement('tr');
			for (const name of ['Estado', 'Gatilho', 'Início', 'Resultado']) headerRow.append(element('th', '', name));
			header.append(headerRow);
			const body = document.createElement('tbody');
			for (const entry of entries) {
				const row = document.createElement('tr');
				const status = element('td');
				status.append(element('span', `status-pill ${entry.status}`, entry.status));
				row.append(status, element('td', '', entry.triggerType), element('td', '', formatDate(entry.createdAt)));
				const result = element('td');
				result.append(button(entry.error ? 'Ver erro' : entry.status === 'succeeded' ? 'Ver saída' : '—', 'secondary-button', () => showOutput(entry)));
				row.append(result);
				body.append(row);
			}
			table.append(header, body);
			section.body.append(table);
		}
		const prior = $('#execution-panel', main);
		section.root.id = 'execution-panel';
		if (prior) prior.replaceWith(section.root);
		else main.append(section.root);
	} catch (error) {
		console.warn(error);
	}
}

function showOutput(entry) {
	const dialog = document.createElement('dialog');
	dialog.className = 'output-dialog';
	const content = element('div', 'panel-body');
	content.append(element('h2', '', entry.error ? 'Falha na execução' : 'Saída da execução'));
	content.append(element('pre', 'execution-output', JSON.stringify(entry.error || entry.output, null, 2)));
	content.append(button('Fechar', 'secondary-button', () => dialog.close()));
	dialog.append(content);
	document.body.append(dialog);
	dialog.addEventListener('close', () => dialog.remove(), { once: true });
	dialog.showModal();
}

async function openCredentials() {
	current = null;
	renderNavigation();
	main.replaceChildren();
	const head = element('div', 'editor-head');
	head.append(element('div'));
	$('.editor-head > div', head).append(element('p', 'eyebrow', 'ACESSO A SERVIÇOS'), element('h1', 'page-title', 'Credenciais'));
	const add = button('＋ Nova credencial', 'primary-button', createCredential);
	head.append(add);
	main.append(head);
	const section = panel('Credenciais criptografadas', 'Chave estável obrigatória');
	section.body.append(element('p', 'muted', 'Valores são criptografados no servidor com AES-256-GCM. O conteúdo secreto não é retornado pela API. HTTP Request pode usar esses valores como cabeçalhos.'));
	const table = element('table', 'table');
	const thead = document.createElement('thead');
	const tr = document.createElement('tr');
	for (const label of ['ID', 'Nome', 'Criada', 'Ação']) tr.append(element('th', '', label));
	thead.append(tr);
	const tbody = document.createElement('tbody');
	try {
		const credentials = await api('/api/credentials');
		for (const credential of credentials) {
			const row = document.createElement('tr');
			row.append(element('td', 'code', credential.id), element('td', '', credential.name), element('td', '', formatDate(credential.createdAt)));
			const action = element('td');
			action.append(button('Excluir', 'danger-button', async () => {
				if (!confirm(`Excluir a credencial “${credential.name}”?`)) return;
				await api(`/api/credentials/${encodeURIComponent(credential.id)}`, { method: 'DELETE' });
				await openCredentials();
			}));
			row.append(action);
			tbody.append(row);
		}
	} catch (error) {
		notify(error.message);
	}
	table.append(thead, tbody);
	section.body.append(table);
	main.append(section.root);
}

async function createCredential() {
	const name = prompt('Nome da credencial');
	if (!name) return;
	const raw = prompt('Valores em JSON (ex.: {"Authorization":"Bearer ..."})');
	if (raw === null) return;
	try {
		const values = JSON.parse(raw);
		await api('/api/credentials', { method: 'POST', body: JSON.stringify({ name, values }) });
		notify('Credencial salva criptografada');
		await openCredentials();
	} catch (error) {
		notify(error.message);
	}
}

function formatDate(value) {
	return value ? new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

function showLogin(message = '') {
	login.hidden = false;
	$('#login-error').textContent = message;
	$('#access-token').value = '';
	$('#access-token').focus();
}

$('#login-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	token = $('#access-token').value;
	try {
		await api('/api/workflows');
		sessionStorage.setItem('squared-token', token);
		login.hidden = true;
		await refreshWorkflows();
	} catch (error) {
		showLogin(error.message);
	}
});

$('#change-token').addEventListener('click', () => {
	token = '';
	sessionStorage.removeItem('squared-token');
	showLogin();
});
$('#new-workflow').addEventListener('click', createWorkflow);
$('#empty-new').addEventListener('click', createWorkflow);

async function boot() {
	const health = await fetch('/healthz').then((response) => response.json()).catch(() => null);
	if (health?.version) $('.sidebar-footer strong').textContent = `Squared ${health.version}`;
	if (!token) return showLogin();
	try {
		await refreshWorkflows();
		login.hidden = true;
	} catch (error) {
		sessionStorage.removeItem('squared-token');
		showLogin(error.message);
	}
}

void boot();
