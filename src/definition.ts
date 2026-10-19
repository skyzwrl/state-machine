export type Guard<C> = (context: C, payload: unknown) => boolean;
export type Action<C> = (context: C, payload: unknown) => void;

// targets are NoInfer so state names only come from the keys of `states`, which turns a typo in a
// target into an error on that target instead of a bogus extra state
export type Transition<S extends string, C> =
	| NoInfer<S>
	| {
			readonly target: NoInfer<S>;
			readonly guard?: Guard<C>;
			readonly action?: Action<C>;
	  };

export interface StateConfig<S extends string, E extends string, C> {
	readonly on?: { readonly [K in E]?: Transition<S, C> };
	readonly enter?: (context: C, from: NoInfer<S> | undefined, payload: unknown) => void;
	readonly exit?: (context: C, to: NoInfer<S>) => void;
	readonly update?: (context: C, dt: number) => void;
	readonly after?: { readonly seconds: number; readonly target: NoInfer<S> };
}

export interface MachineDefinition<S extends string, E extends string, C> {
	readonly initial: NoInfer<S>;
	readonly context: C;
	readonly states: { readonly [K in S]: StateConfig<S, E, C> };
}

export interface CompiledTransition<S, C> {
	readonly target: S;
	readonly guard?: Guard<C>;
	readonly action?: Action<C>;
}

export interface StateNode<S extends string, E extends string, C> {
	readonly transitions: ReadonlyMap<E, CompiledTransition<S, C>>;
	readonly enter?: (context: C, from: S | undefined, payload: unknown) => void;
	readonly exit?: (context: C, to: S) => void;
	readonly update?: (context: C, dt: number) => void;
	readonly after?: { readonly seconds: number; readonly target: S };
}

function show(value: unknown): string {
	return typeIs(value, "string") ? `"${value}"` : tostring(value);
}

// the types already reject bad definitions at compile time, this catches the ones that get past them
// (casts, definitions built from data) before they fail halfway through a transition
export function compileDefinition<S extends string, E extends string, C>(
	definition: MachineDefinition<S, E, C>,
): ReadonlyMap<S, StateNode<S, E, C>> {
	// plain tables at runtime, viewed as maps so iteration keeps the real key types
	const states = definition.states as unknown as ReadonlyMap<S, StateConfig<S, E, C>>;
	const isState = (name: unknown): name is S => typeIs(name, "string") && states.has(name as S);

	if (!isState(definition.initial)) {
		throw `invalid state machine: initial state ${show(definition.initial)} isn't defined`;
	}

	const nodes = new Map<S, StateNode<S, E, C>>();
	for (const [name, config] of states) {
		const transitions = new Map<E, CompiledTransition<S, C>>();
		if (config.on !== undefined) {
			for (const [event, spec] of config.on as unknown as ReadonlyMap<E, Transition<S, C>>) {
				const transition = typeIs(spec, "string") ? { target: spec } : spec;
				if (!isState(transition.target)) {
					throw `invalid state machine: state "${name}" sends "${event}" to ${show(transition.target)}, which isn't defined`;
				}
				transitions.set(event, {
					target: transition.target,
					guard: transition.guard,
					action: transition.action,
				});
			}
		}

		const after = config.after;
		if (after !== undefined) {
			// written so NaN fails too
			if (!(after.seconds > 0 && after.seconds < math.huge)) {
				throw `invalid state machine: state "${name}" has after.seconds = ${after.seconds}, expected a positive number`;
			}
			if (!isState(after.target)) {
				throw `invalid state machine: state "${name}" times out to ${show(after.target)}, which isn't defined`;
			}
		}

		nodes.set(name, {
			transitions,
			enter: config.enter,
			exit: config.exit,
			update: config.update,
			after: after !== undefined ? { seconds: after.seconds, target: after.target } : undefined,
		});
	}

	return nodes;
}
