import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { GraphExecutionEngine, NodeAdapterRegistry } from '../../execution/graph-engine.ts';
import { N8nNodePackageRuntime } from './runtime.ts';

const manual = { id: 'manual', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} };

/** Execute checked-in, deterministic workflows against the installed package modules. */
export async function runN8nBaseCompatibilityProbe(packagesDirectory) {
	const registry = new NodeAdapterRegistry();
	const runtime = new N8nNodePackageRuntime(packagesDirectory);
	const discovery = await runtime.initialize(registry);
	if (!discovery.packages.includes('n8n-nodes-base')) throw new Error('n8n-nodes-base is not installed in SQUARED_N8N_PACKAGES_DIR');
	let controlledApiServerUrl = '';
	const engine = new GraphExecutionEngine(registry, async (reference, credentialType) => {
		if (credentialType === 'httpHeaderAuth' && reference.id === 'squared-fixture-credential') return { name: 'x-squared-token', value: 'fixture-token' };
		if (credentialType === 'githubApi' && reference.id === 'squared-github-credential') return { server: controlledApiServerUrl, accessToken: 'fixture-github-token' };
		return null;
	});
	const executions = [];
	const execute = async (test, nodeType, typeVersion, workflow, input, expected) => {
		const result = await engine.execute(workflow, { input });
		assert.equal(result.status, 'succeeded', result.error);
		if (expected.output) assert.deepEqual(result.output.map((item) => item.json), expected.output);
		if (expected.binary) assert.deepEqual(result.output.map((item) => item.binary ?? {}), expected.binary);
		if (expected.outputsByNode) {
			for (const [name, ports] of Object.entries(expected.outputsByNode)) {
				assert.deepEqual(result.outputsByNode[name].map((port) => port.map((item) => item.json)), ports);
			}
		}
		runtime.catalog.markValidated(nodeType, typeVersion, test);
		executions.push({ nodeType, typeVersion, test, status: 'passed', output: result.output, outputsByNode: result.outputsByNode, nodeRuns: result.nodeRuns });
	};

	await execute('Set v3.5 expression and keep input fields', 'n8n-nodes-base.set', 3.5, {
		name: 'Published Set v3.5',
		nodes: [manual, {
			id: 'set', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.5,
			parameters: { mode: 'manual', assignments: { assignments: [{ id: 'assignment-1', name: 'result', value: '={{$json.value}}', type: 'string' }] }, includeOtherFields: true, options: {} },
		}],
		connections: { Manual: { main: [[{ node: 'Set', type: 'main', index: 0 }]] } },
	}, { value: 'from-input', keep: 7 }, { output: [{ value: 'from-input', keep: 7, result: 'from-input' }] });

	await execute('Set v1 expression and keep input fields', 'n8n-nodes-base.set', 1, {
		name: 'Published Set v1',
		nodes: [manual, {
			id: 'set-v1', name: 'Set v1', type: 'n8n-nodes-base.set', typeVersion: 1,
			parameters: { keepOnlySet: false, values: { string: [{ name: 'legacyResult', value: '={{$json.value}}' }] }, options: {} },
		}],
		connections: { Manual: { main: [[{ node: 'Set v1', type: 'main', index: 0 }]] } },
	}, { value: 'version-one', keep: 8 }, { output: [{ value: 'version-one', keep: 8, legacyResult: 'version-one' }] });

	const ifNode = {
		id: 'if', name: 'If', type: 'n8n-nodes-base.if', typeVersion: 2.3,
		parameters: {
			conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 }, conditions: [{ leftValue: '={{$json.allow}}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' },
			options: {},
		},
	};
	await execute('If v2.3 true and false outputs', 'n8n-nodes-base.if', 2.3, {
		name: 'Published If v2.3',
		nodes: [manual, ifNode,
			{ id: 'true', name: 'True', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} },
			{ id: 'false', name: 'False', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} },
		],
		connections: { Manual: { main: [[{ node: 'If', type: 'main', index: 0 }]] }, If: { main: [[{ node: 'True', type: 'main', index: 0 }], [{ node: 'False', type: 'main', index: 0 }]] } },
	}, [{ json: { allow: true } }, { json: { allow: false } }], { output: [{ allow: true }, { allow: false }], outputsByNode: { If: [[{ allow: true }], [{ allow: false }]] } });

	await execute('Filter v2.3 true and false outputs', 'n8n-nodes-base.filter', 2.3, {
		name: 'Published Filter v2.3',
		nodes: [manual, {
			id: 'filter', name: 'Filter', type: 'n8n-nodes-base.filter', typeVersion: 2.3,
			parameters: { conditions: ifNode.parameters.conditions, options: {} },
		},
		{ id: 'kept', name: 'Kept', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} },
		{ id: 'discarded', name: 'Discarded', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} },
		],
		connections: { Manual: { main: [[{ node: 'Filter', type: 'main', index: 0 }]] }, Filter: { main: [[{ node: 'Kept', type: 'main', index: 0 }], [{ node: 'Discarded', type: 'main', index: 0 }]] } },
	}, [{ json: { allow: true } }, { json: { allow: false } }], { output: [{ allow: true }, { allow: false }], outputsByNode: { Filter: [[{ allow: true }], [{ allow: false }]] } });

	const rules = [
		{ conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: '={{$json.status}}', rightValue: 'active', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' } },
		{ conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: '={{$json.status}}', rightValue: 'inactive', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' } },
	];
	await execute('Switch v3.3 rule outputs and fallback none', 'n8n-nodes-base.switch', 3.3, {
		name: 'Published Switch v3.3',
		nodes: [manual, {
			id: 'switch', name: 'Switch', type: 'n8n-nodes-base.switch', typeVersion: 3.3,
			parameters: { mode: 'rules', rules: { values: rules }, options: { fallbackOutput: 'none' } },
		},
		{ id: 'active', name: 'Active', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} },
		{ id: 'inactive', name: 'Inactive', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} },
		],
		connections: { Manual: { main: [[{ node: 'Switch', type: 'main', index: 0 }]] }, Switch: { main: [[{ node: 'Active', type: 'main', index: 0 }], [{ node: 'Inactive', type: 'main', index: 0 }]] } },
	}, [{ json: { status: 'active' } }, { json: { status: 'inactive' } }, { json: { status: 'pending' } }], { output: [{ status: 'active' }, { status: 'inactive' }], outputsByNode: { Switch: [[{ status: 'active' }], [{ status: 'inactive' }]] } });

	await execute('NoOp v1 passes items unchanged', 'n8n-nodes-base.noOp', 1, {
		name: 'Published NoOp v1',
		nodes: [manual, { id: 'no-op', name: 'No Operation', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} }],
		connections: { Manual: { main: [[{ node: 'No Operation', type: 'main', index: 0 }]] } },
	}, { untouched: true }, { output: [{ untouched: true }] });

	await execute('Limit v1 returns the configured first items', 'n8n-nodes-base.limit', 1, {
		name: 'Published Limit v1',
		nodes: [manual, { id: 'limit', name: 'Limit', type: 'n8n-nodes-base.limit', typeVersion: 1, parameters: { maxItems: 1, keep: 'firstItems' } }],
		connections: { Manual: { main: [[{ node: 'Limit', type: 'main', index: 0 }]] } },
	}, [{ json: { id: 1 } }, { json: { id: 2 } }], { output: [{ id: 1 }] });

	await execute('Sort v1 orders items using its declared field configuration', 'n8n-nodes-base.sort', 1, {
		name: 'Published Sort v1',
		nodes: [manual, { id: 'sort', name: 'Sort', type: 'n8n-nodes-base.sort', typeVersion: 1, parameters: { type: 'simple', sortFieldsUi: { sortField: [{ fieldName: 'id', order: 'ascending' }] }, options: {} } }],
		connections: { Manual: { main: [[{ node: 'Sort', type: 'main', index: 0 }]] } },
	}, [{ json: { id: 2 } }, { json: { id: 1 } }], { output: [{ id: 1 }, { id: 2 }] });

	await execute('Remove Duplicates v2 removes repeated input items', 'n8n-nodes-base.removeDuplicates', 2, {
		name: 'Published Remove Duplicates v2',
		nodes: [manual, { id: 'dedupe', name: 'Remove Duplicates', type: 'n8n-nodes-base.removeDuplicates', typeVersion: 2, parameters: { operation: 'removeDuplicateInputItems', compare: 'allFields', options: {} } }],
		connections: { Manual: { main: [[{ node: 'Remove Duplicates', type: 'main', index: 0 }]] } },
	}, [{ json: { id: 1 } }, { json: { id: 1 } }, { json: { id: 2 } }], { output: [{ id: 1 }, { id: 2 }] });

	await execute('Rename Keys v1 renames a configured JSON property', 'n8n-nodes-base.renameKeys', 1, {
		name: 'Published Rename Keys v1',
		nodes: [manual, { id: 'rename', name: 'Rename Keys', type: 'n8n-nodes-base.renameKeys', typeVersion: 1, parameters: { keys: { key: [{ currentKey: 'old', newKey: 'fresh' }] }, additionalOptions: {} } }],
		connections: { Manual: { main: [[{ node: 'Rename Keys', type: 'main', index: 0 }]] } },
	}, { old: 'value', keep: true }, { output: [{ fresh: 'value', keep: true }] });

	await execute('Split Out v1 expands an array while keeping other fields', 'n8n-nodes-base.splitOut', 1, {
		name: 'Published Split Out v1',
		nodes: [manual, { id: 'split', name: 'Split Out', type: 'n8n-nodes-base.splitOut', typeVersion: 1, parameters: { fieldToSplitOut: 'values', include: 'allOtherFields', options: {} } }],
		connections: { Manual: { main: [[{ node: 'Split Out', type: 'main', index: 0 }]] } },
	}, { values: ['a', 'b'], keep: 7 }, { output: [{ keep: 7, values: 'a' }, { keep: 7, values: 'b' }] });

	await execute('Aggregate v1 groups a selected field into one item', 'n8n-nodes-base.aggregate', 1, {
		name: 'Published Aggregate v1',
		nodes: [manual, { id: 'aggregate', name: 'Aggregate', type: 'n8n-nodes-base.aggregate', typeVersion: 1, parameters: { aggregate: 'aggregateIndividualFields', fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: 'value', renameField: false }] }, destinationFieldName: 'values', include: 'allFields', options: {} } }],
		connections: { Manual: { main: [[{ node: 'Aggregate', type: 'main', index: 0 }]] } },
	}, [{ json: { value: 1, group: 'a' } }, { json: { value: 2, group: 'b' } }], { output: [{ value: [1, 2] }] });

	await execute('Date & Time v2 formats a fixed date deterministically', 'n8n-nodes-base.dateTime', 2, {
		name: 'Published Date & Time v2',
		nodes: [manual, { id: 'date-time', name: 'Date & Time', type: 'n8n-nodes-base.dateTime', typeVersion: 2, parameters: { operation: 'formatDate', date: '2024-01-02T03:04:05.000Z', format: 'yyyy-MM-dd', outputFieldName: 'formattedDate', options: { includeInputFields: true } } }],
		connections: { Manual: { main: [[{ node: 'Date & Time', type: 'main', index: 0 }]] } },
	}, { tag: 'fixed' }, { output: [{ tag: 'fixed', formattedDate: '2024-01-02' }] });

	await execute('Summarize v1.1 aggregates numeric input fields', 'n8n-nodes-base.summarize', 1.1, {
		name: 'Published Summarize v1.1',
		nodes: [manual, { id: 'summarize', name: 'Summarize', type: 'n8n-nodes-base.summarize', typeVersion: 1.1, parameters: { fieldsToSummarize: { values: [{ aggregation: 'sum', field: 'amount' }] }, fieldsToSplitBy: '', options: {} } }],
		connections: { Manual: { main: [[{ node: 'Summarize', type: 'main', index: 0 }]] } },
	}, [{ json: { amount: 3 } }, { json: { amount: 7 } }], { output: [{ sum_amount: 10 }] });

	await execute('Compare Datasets v2.3 joins two input ports and routes matching items', 'n8n-nodes-base.compareDatasets', 2.3, {
		name: 'Published Compare Datasets v2.3',
		nodes: [manual,
			{ id: 'set-a', name: 'A', type: 'n8n-nodes-base.set', typeVersion: 3.5, parameters: { mode: 'manual', assignments: { assignments: [{ name: 'id', value: 1, type: 'number' }, { name: 'value', value: 'same', type: 'string' }] }, includeOtherFields: false, options: {} } },
			{ id: 'set-b', name: 'B', type: 'n8n-nodes-base.set', typeVersion: 3.5, parameters: { mode: 'manual', assignments: { assignments: [{ name: 'id', value: 1, type: 'number' }, { name: 'value', value: 'same', type: 'string' }] }, includeOtherFields: false, options: {} } },
			{ id: 'compare', name: 'Compare', type: 'n8n-nodes-base.compareDatasets', typeVersion: 2.3, parameters: { mergeByFields: { values: [{ field1: 'id', field2: 'id' }] }, resolve: 'includeBoth', options: {} } },
		],
		connections: {
			Manual: { main: [[{ node: 'A', type: 'main', index: 0 }, { node: 'B', type: 'main', index: 0 }]] },
			A: { main: [[{ node: 'Compare', type: 'main', index: 0 }]] },
			B: { main: [[{ node: 'Compare', type: 'main', index: 1 }]] },
		},
	}, { ignored: true }, { output: [{ id: 1, value: 'same' }], outputsByNode: { Compare: [[], [{ id: 1, value: 'same' }], [], []] } });

	await execute('Convert to/from Binary Data v1 converts JSON bytes using the published node', 'n8n-nodes-base.moveBinaryData', 1, {
		name: 'Published Convert to Binary v1',
		nodes: [manual, { id: 'binary', name: 'Move Binary Data', type: 'n8n-nodes-base.moveBinaryData', typeVersion: 1, parameters: { mode: 'jsonToBinary', convertAllData: false, sourceKey: 'value', destinationKey: 'payload', options: { useRawData: true, mimeType: 'text/plain', fileName: 'payload.txt' } } }],
		connections: { Manual: { main: [[{ node: 'Move Binary Data', type: 'main', index: 0 }]] } },
	}, { value: 'hello', keep: true }, {
		output: [{ keep: true }],
		binary: [{ payload: { data: 'aGVsbG8=', fileName: 'payload.txt', fileExtension: 'txt', fileSize: '5 B', mimeType: 'text/plain', fileType: 'text' } }],
	});

	await execute('Convert to/from Binary Data v1 parses inline JSON binary data', 'n8n-nodes-base.moveBinaryData', 1, {
		name: 'Published Convert from Binary v1',
		nodes: [manual, { id: 'binary-json', name: 'Move Binary Data', type: 'n8n-nodes-base.moveBinaryData', typeVersion: 1, parameters: { mode: 'binaryToJson', setAllData: true, sourceKey: 'data', options: { encoding: 'utf8' } } }],
		connections: { Manual: { main: [[{ node: 'Move Binary Data', type: 'main', index: 0 }]] } },
	}, { json: {}, binary: { data: { data: Buffer.from('{"ok":true}').toString('base64'), mimeType: 'application/json', fileName: 'payload.json' } } }, {
		output: [{ ok: true }],
		binary: [{}],
	});

	await execute('XML v1 parses XML into a JSON object', 'n8n-nodes-base.xml', 1, {
		name: 'Published XML v1',
		nodes: [manual, { id: 'xml', name: 'XML', type: 'n8n-nodes-base.xml', typeVersion: 1, parameters: { mode: 'xmlToJson', dataPropertyName: 'data', options: {} } }],
		connections: { Manual: { main: [[{ node: 'XML', type: 'main', index: 0 }]] } },
	}, { data: '<root><name>Squared</name></root>' }, { output: [{ root: { name: 'Squared' } }] });

	await execute('HTML v1.2 extracts a CSS-selected text value', 'n8n-nodes-base.html', 1.2, {
		name: 'Published HTML v1.2',
		nodes: [manual, { id: 'html', name: 'HTML', type: 'n8n-nodes-base.html', typeVersion: 1.2, parameters: { operation: 'extractHtmlContent', sourceData: 'json', dataPropertyName: 'html', extractionValues: { values: [{ key: 'heading', cssSelector: 'h1', returnValue: 'text', returnArray: false }] }, options: { trimValues: true, cleanUpText: true } } }],
		connections: { Manual: { main: [[{ node: 'HTML', type: 'main', index: 0 }]] } },
	}, { html: '<main><h1>Squared</h1></main>' }, { output: [{ heading: 'Squared' }] });

	await execute('Markdown v1 converts HTML using the published converter', 'n8n-nodes-base.markdown', 1, {
		name: 'Published Markdown v1',
		nodes: [manual, { id: 'markdown', name: 'Markdown', type: 'n8n-nodes-base.markdown', typeVersion: 1, parameters: { mode: 'htmlToMarkdown', html: '<h1>Squared</h1><p>Hello <strong>world</strong></p>', destinationKey: 'markdown', options: {} } }],
		connections: { Manual: { main: [[{ node: 'Markdown', type: 'main', index: 0 }]] } },
	}, { source: 'fixture' }, { output: [{ source: 'fixture', markdown: '# Squared\n\nHello **world**' }] });

	const fixtureServer = createServer((request, response) => {
		const url = new URL(request.url, 'http://127.0.0.1');
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ method: request.method, path: url.pathname, query: url.searchParams.get('q'), headerCredentialAccepted: request.headers['x-squared-token'] === 'fixture-token', githubCredentialAccepted: request.headers.authorization === 'token fixture-github-token' }));
	});
	await new Promise((resolve, reject) => {
		fixtureServer.once('error', reject);
		fixtureServer.listen(0, '127.0.0.1', resolve);
	});
	try {
		const address = fixtureServer.address();
		if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind to an ephemeral port');
		controlledApiServerUrl = `http://127.0.0.1:${address.port}`;
		await execute('HTTP Request v4.5 to local controlled JSON fixture', 'n8n-nodes-base.httpRequest', 4.5, {
			name: 'Published HTTP Request v4.5',
			nodes: [manual, {
				id: 'http', name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5,
				parameters: { method: 'GET', url: `http://127.0.0.1:${address.port}/fixture?q=local`, authentication: 'none', sendHeaders: false, sendBody: false, options: { response: { response: { responseFormat: 'json' } } } },
			}],
			connections: { Manual: { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] } },
		}, { source: 'test' }, { output: [{ method: 'GET', path: '/fixture', query: 'local', headerCredentialAccepted: false, githubCredentialAccepted: false }] });
		await execute('HTTP Request v4.5 applies a real HttpHeaderAuth credential', 'n8n-nodes-base.httpRequest', 4.5, {
			name: 'Published HTTP Request with Header Auth',
			nodes: [manual, {
				id: 'http-auth', name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5,
				parameters: { method: 'GET', url: `http://127.0.0.1:${address.port}/fixture`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendHeaders: false, sendBody: false, options: { response: { response: { responseFormat: 'json' } } } },
				credentials: { httpHeaderAuth: { id: 'squared-fixture-credential', name: 'Fixture Header' } },
			}],
			connections: { Manual: { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] } },
		}, { source: 'test' }, { output: [{ method: 'GET', path: '/fixture', query: null, headerCredentialAccepted: true, githubCredentialAccepted: false }] });
		await execute('GitHub repository:get uses the published node and GithubApi credential against the local fixture', 'n8n-nodes-base.github', 1, {
			name: 'Published GitHub repository:get with a controlled API endpoint',
			nodes: [manual, {
				id: 'github', name: 'GitHub', type: 'n8n-nodes-base.github', typeVersion: 1,
				parameters: { authentication: 'accessToken', resource: 'repository', operation: 'get', owner: { mode: 'name', value: 'squared' }, repository: { mode: 'name', value: 'fixture' } },
				credentials: { githubApi: { id: 'squared-github-credential', name: 'Fixture GitHub API' } },
			}],
			connections: { Manual: { main: [[{ node: 'GitHub', type: 'main', index: 0 }]] } },
		}, { source: 'test' }, { output: [{ method: 'GET', path: '/repos/squared/fixture', query: null, headerCredentialAccepted: false, githubCredentialAccepted: true }] });
	} finally {
		await new Promise((resolve, reject) => fixtureServer.close((error) => error ? reject(error) : resolve()));
	}

	return {
		packages: discovery.packages,
		nodesDiscovered: discovery.nodes.length,
		executions,
		nodes: runtime.getSnapshot().nodes,
		credentials: runtime.getSnapshot().credentials,
	};
}
