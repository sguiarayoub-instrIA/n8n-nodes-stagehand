import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseLLM } from '@langchain/core/language_models/llms';
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { ApplicationError, assert, NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import { LogLine, Stagehand as StagehandCore } from '@browserbasehq/stagehand';
import { z, ZodTypeAny } from 'zod';
import jsonToZod from 'json-to-zod';
import jsonSchemaToZod from 'json-schema-to-zod';

type Field = {
	fieldName: string;
	fieldType: string;
	optional: boolean;
};

// Filter out messages that contain image/screenshot data entirely
function sanitizeMessages(messages: LogLine[]): any[] {
	return messages
		.filter(msg => {
			const str = JSON.stringify(msg);
			return !str.includes('image') && !str.includes('screenshot') && str.length < 5000;
		})
		.map(msg => ({
			category: msg.category,
			message: msg.message,
			level: msg.level,
		}));
}

// Extract usage data from aisdk messages
function extractUsageFromMessages(messages: LogLine[]): { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null {
	let totalPrompt = 0;
	let totalCompletion = 0;
	let totalTokens = 0;
	let found = false;

	for (const msg of messages) {
		if (msg.category === 'aisdk' && msg.auxiliary?.response?.value) {
			try {
				const parsed = JSON.parse(msg.auxiliary.response.value);
				if (parsed.usage) {
					found = true;
					totalPrompt += parsed.usage.prompt_tokens || parsed.usage.promptTokens || 0;
					totalCompletion += parsed.usage.completion_tokens || parsed.usage.completionTokens || 0;
					totalTokens += parsed.usage.total_tokens || parsed.usage.totalTokens || 0;
				}
			} catch {
				// Ignore parse errors
			}
		}
	}

	return found ? { prompt_tokens: totalPrompt, completion_tokens: totalCompletion, total_tokens: totalTokens } : null;
}

export class Stagehand implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Stagehand',
		name: 'stagehand',
		icon: 'file:stagehand.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Control browser using Stagehand with CDP URL',
		defaults: {
			name: 'Stagehand',
		},
		inputs: [
			NodeConnectionType.Main,
			{
				displayName: 'Model',
				maxConnections: 1,
				type: NodeConnectionType.AiLanguageModel,
				required: false,
			},
		],
		outputs: [NodeConnectionType.Main],
		usableAsTool: true,
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				options: [
					{
						name: 'Act',
						value: 'act',
						description: 'Execute an action on the page using natural language',
						action: 'Execute an action on the page',
					},
					{
						name: 'Extract',
						value: 'extract',
						description: 'Extract structured data from the page',
						action: 'Extract data from the page',
					},
					{
						name: 'Observe',
						value: 'observe',
						description: 'Observe the page and plan an action',
						action: 'Observe the page',
					},
					{
						name: 'Agent',
						value: 'agent',
						description: 'Execute a complex multi-step task autonomously',
						action: 'Run autonomous agent',
					},
				],
				default: 'act',
			},
			{
				displayName: 'CDP URL',
				name: 'cdpUrl',
				type: 'string',
				default: '',
				placeholder: 'ws://localhost:9222/devtools/browser/...',
				description: 'Chrome DevTools Protocol URL to connect to the browser',
				required: true,
			},
			{
				displayName: 'Page URL',
				name: 'pageUrl',
				type: 'string',
				default: '',
				placeholder: 'https://google.com',
				description: 'URL to navigate to before performing the action (required for act/extract)',
				required: false,
			},
			{
				displayName: 'Instructions',
				name: 'instructions',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				default: '',
				placeholder: 'Click "Accept cookies"\nType "hello" in the search box\nClick the search button',
				description: 'Instructions for Stagehand (one per line, executed in sequence)',
				required: true,
			},
			// Agent-specific options
			{
				displayName: 'Max Steps',
				name: 'maxSteps',
				type: 'number',
				default: 10,
				description: 'Maximum number of steps the agent can take to complete the task',
				displayOptions: {
					show: {
						operation: ['agent'],
					},
				},
			},
			{
				displayName: 'Context',
				name: 'agentContext',
				type: 'string',
				typeOptions: {
					rows: 3,
				},
				default: '',
				placeholder: 'Additional context for the agent...',
				description: 'Additional context to help the agent understand the task',
				displayOptions: {
					show: {
						operation: ['agent'],
					},
				},
			},
			{
				displayName: 'Schema Source',
				name: 'schemaSource',
				type: 'options',
				options: [
					{
						name: 'Field List',
						value: 'fieldList',
					},
					{
						name: 'Example JSON',
						value: 'example',
					},
					{
						name: 'JSON Schema',
						value: 'jsonSchema',
					},
					{
						name: 'Manual Zod',
						value: 'manual',
					},
				],
				displayOptions: {
					show: {
						operation: ['extract'],
					},
				},
				default: 'fieldList',
				required: true,
			},
			{
				displayName: 'Fields',
				name: 'fields',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
					multipleValueButtonText: 'Add Field',
					minRequiredFields: 1,
				},
				default: [],
				description: 'List of output fields and their types',
				options: [
					{
						displayName: 'Field',
						name: 'field',
						values: [
							{
								displayName: 'Name',
								name: 'fieldName',
								type: 'string',
								default: '',
								description: 'Property name in the extracted object',
								required: true,
							},
							{
								displayName: 'Type',
								name: 'fieldType',
								type: 'options',
								options: [
									{
										name: 'Array',
										value: 'array',
									},
									{
										name: 'Boolean',
										value: 'boolean',
									},
									{
										name: 'Number',
										value: 'number',
									},
									{
										name: 'Object',
										value: 'object',
									},
									{
										name: 'String',
										value: 'string',
									},
								],
								default: 'string',
								required: true,
							},
							{
								displayName: 'Optional',
								name: 'optional',
								type: 'boolean',
								default: false,
								required: true,
							},
						],
					},
				],
				displayOptions: {
					show: {
						operation: ['extract'],
						schemaSource: ['fieldList'],
					},
				},
			},
			{
				displayName: 'Example JSON',
				name: 'exampleJson',
				type: 'json',
				typeOptions: {
					rows: 4,
				},
				displayOptions: {
					show: {
						operation: ['extract'],
						schemaSource: ['example'],
					},
				},
				default: '{\n  "title": "My Title",\n  "description": "My Description"\n}',
				required: true,
			},
			{
				displayName: 'JSON Schema',
				name: 'jsonSchema',
				type: 'json',
				typeOptions: {
					rows: 6,
				},
				displayOptions: {
					show: {
						operation: ['extract'],
						schemaSource: ['jsonSchema'],
					},
				},
				default:
					'{\n  "$schema": "http://json-schema.org/draft-07/schema#",\n  "type": "object",\n  "properties": {\n    "title": { "type": "string", "description": "The page title" },\n    "description": { "type": "string", "description": "The page description" }\n  },\n  "required": ["title", "description"]\n}',
				required: true,
			},
			{
				displayName: 'Zod Code',
				name: 'manualZod',
				type: 'string',
				typeOptions: { rows: 6 },
				displayOptions: {
					show: {
						operation: ['extract'],
						schemaSource: ['manual'],
					},
				},
				default:
					'z.object({\n  title: z.string().describe("The page title"),\n  description: z.string().describe("The page description")\n})',
				required: true,
			},
			// ADVANCED OPTIONS
			{
				displayName: 'Advanced Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				description: 'Advanced options for Stagehand',
				options: [
					{
						displayName: 'Enable Caching',
						name: 'enableCaching',
						type: 'boolean',
						default: true,
						description: 'Whether to enable caching for Stagehand operations',
					},
					{
						displayName: 'Log Messages',
						name: 'logMessages',
						type: 'boolean',
						default: false,
						description: 'Whether to include Stagehand log messages in the node output',
					},
					{
						displayName: 'Verbose Level',
						name: 'verbose',
						type: 'options',
						options: [
							{
								name: 'No Logs',
								value: 0,
							},
							{
								name: 'Only Errors',
								value: 1,
							},
							{
								name: 'All Logs',
								value: 2,
							},
						],
						default: 0,
						description: 'Level of verbosity for Stagehand internal logging',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const results: INodeExecutionData[] = [];
		const model = await this.getInputConnectionData(NodeConnectionType.AiLanguageModel, 0);

		assert(Stagehand.isChatInstance(model), 'A Chat Model is required');
		assert('model' in model, 'Model is not defined in the input connection data');
		assert('apiKey' in model, 'API Key is not defined in the input connection data');
		assert(typeof model.model === 'string', 'Model must be a string');
		assert(typeof model.apiKey === 'string', 'API Key must be a string');

		for (let i = 0; i < items.length; i++) {
			const operation = this.getNodeParameter('operation', i) as string;
			const cdpUrl = this.getNodeParameter('cdpUrl', i, '') as string;
			const enableCaching = this.getNodeParameter('options.enableCaching', i, true) as boolean;
			const logMessages = this.getNodeParameter('options.logMessages', i, false) as boolean;
			const verbose = this.getNodeParameter('options.verbose', i, 0) as 0 | 1 | 2;

			const messages: LogLine[] = [];
			// Map provider names to what Stagehand expects
			let provider = model.lc_namespace[2];
			if (provider === 'google_genai' || provider === 'google_vertexai') {
				provider = 'google';
			} else if (model.model.includes('deepseek')) {
				provider = 'deepseek';
			}

			// Debug logging
			console.log('[Stagehand Debug] Provider:', provider);
			console.log('[Stagehand Debug] Model:', model.model);
			console.log('[Stagehand Debug] Full modelName:', provider + '/' + model.model);
			console.log('[Stagehand Debug] CDP URL:', cdpUrl);

			const stagehand = new StagehandCore({
				env: 'LOCAL',
				enableCaching,
				verbose,
				logger: logMessages
					? (message) => {
							messages.push(message);
						}
					: undefined,
				modelName: provider + '/' + model.model,
				modelClientOptions: {
					apiKey: model.apiKey,
				},
				localBrowserLaunchOptions: {
					cdpUrl,
				},
			});
			await stagehand.init();

			// Navigate to page URL if provided
			const pageUrl = this.getNodeParameter('pageUrl', i, '') as string;
			if (pageUrl) {
				console.log('[Stagehand Debug] Navigating to:', pageUrl);
				await stagehand.page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
				console.log('[Stagehand Debug] Navigation complete');
			}

			try {
				switch (operation) {
					case 'act': {
						const instructionsRaw = this.getNodeParameter('instructions', i, '') as string;
						const instructions = instructionsRaw.split('\n').map(s => s.trim()).filter(s => s.length > 0);

						const actResults: any[] = [];
						for (const instruction of instructions) {
							console.log('[Stagehand Debug] Executing instruction:', instruction);
							const result = await stagehand.page.act(instruction);
							actResults.push({ instruction, result });
						}

						results.push({
							json: {
								operation,
								results: actResults,
								currentUrl: stagehand.page.url(),
								...(logMessages ? { messages: sanitizeMessages(messages) } : {}),
							},
						});
						break;
					}

					case 'extract': {
						const instructionsRaw = this.getNodeParameter('instructions', i, '') as string;
						const instruction = instructionsRaw.split('\n')[0]?.trim() || '';
						const schemaSource = this.getNodeParameter('schemaSource', i, 'example') as string;

						let schema: z.ZodObject<any>;
						switch (schemaSource) {
							case 'fieldList': {
								const fields = this.getNodeParameter('fields.field', i, []) as any[];
								schema = Stagehand.fieldsToZodSchema(fields);
								break;
							}

							case 'example': {
								const example = this.getNodeParameter('exampleJson', i) as string;
								schema = new Function('z', `${jsonToZod(JSON.parse(example))}return schema;`)(z);
								break;
							}

							case 'jsonSchema': {
								const jsonSchema = this.getNodeParameter('jsonSchema', i) as string;
								schema = new Function('z', `return ${jsonSchemaToZod(JSON.parse(jsonSchema))};`)(z);
								break;
							}

							case 'manual': {
								const zodCode = this.getNodeParameter('manualZod', i) as string;
								schema = new Function('z', `return ${zodCode};`)(z);
								break;
							}

							default: {
								throw new ApplicationError(`Unsupported schema source: ${schemaSource}`);
							}
						}

						results.push({
							json: {
								operation,
								result: await stagehand.page.extract({
									instruction,
									schema,
								}),
								...(logMessages ? { messages: sanitizeMessages(messages) } : {}),
							},
						});
						break;
					}

					case 'observe': {
						const instructionsRaw = this.getNodeParameter('instructions', i, '') as string;
						const instruction = instructionsRaw.split('\n')[0]?.trim() || '';

						results.push({
							json: {
								operation,
								result: await stagehand.page.observe({
									instruction,
								}),
								...(logMessages ? { messages: sanitizeMessages(messages) } : {}),
							},
						});
						break;
					}

					case 'agent': {
						const instructionsRaw = this.getNodeParameter('instructions', i, '') as string;
						const instruction = instructionsRaw.trim();
						const maxSteps = this.getNodeParameter('maxSteps', i, 10) as number;
						const agentContext = this.getNodeParameter('agentContext', i, '') as string;

						// Create agent and execute
						const agent = stagehand.agent();
						const agentResult = await agent.execute({
							instruction,
							maxSteps,
							autoScreenshot: true,
							...(agentContext ? { context: agentContext } : {}),
						});

						// Extract usage from aisdk messages (contains token counts)
						const usage = extractUsageFromMessages(messages);

						// Simplify actions for cleaner output
						const simplifiedActions = agentResult.actions.map((action: any) => ({
							type: action.type,
							reasoning: action.reasoning,
							parameters: action.parameters,
							taskCompleted: action.taskCompleted,
						}));

						results.push({
							json: {
								operation,
								success: agentResult.success,
								message: agentResult.message,
								completed: agentResult.completed,
								actions: simplifiedActions,
								actionCount: agentResult.actions.length,
								usage,
								currentUrl: stagehand.page.url(),
								...(logMessages ? { messages: sanitizeMessages(messages) } : {}),
							},
						});
						break;
					}

					default: {
						throw new ApplicationError(`Unsupported operation: ${operation}`);
					}
				}
			} catch (error) {
				results.push({
					error: new NodeOperationError(this.getNode(), error as Error, {
						message: `Error executing Stagehand operation: ${error.message}`,
					}),
					json: {
						operation,
						...(logMessages ? { messages: sanitizeMessages(messages) } : {}),
					},
				});
			} finally {
				await stagehand.close();
			}
		}

		return [results];
	}

	static isChatInstance(model: unknown): model is BaseChatModel {
		const namespace = (model as BaseLLM)?.lc_namespace ?? [];

		return namespace.includes('chat_models');
	}

	static fieldsToZodSchema(fields: Field[]): z.ZodObject<any> {
		const shape: Record<string, ZodTypeAny> = {};

		for (const { fieldName, fieldType, optional } of fields) {
			let zType: ZodTypeAny;

			switch (fieldType) {
				case 'string':
					zType = z.string();
					break;
				case 'number':
					zType = z.number();
					break;
				case 'boolean':
					zType = z.boolean();
					break;
				case 'array':
					zType = z.array(z.any());
					break; // puoi espandere
				case 'object':
					zType = z.object({}).passthrough();
					break;
				default:
					zType = z.any();
			}

			shape[fieldName] = optional ? zType.optional() : zType;
		}

		return z.object(shape);
	}
}
