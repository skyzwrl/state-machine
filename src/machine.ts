import { CompiledTransition, MachineDefinition, StateNode, compileDefinition } from "./definition";

// a step still queueing events after this many is two hooks sending each other events forever,
// failing loudly beats hanging the server
const MAX_QUEUED_EVENTS = 100;

export type TransitionListener<S extends string, E extends string> = (from: S, to: S, event: E | undefined) => void;

interface Listener<S extends string, E extends string> {
	readonly callback: TransitionListener<S, E>;
	connected: boolean;
}

interface QueuedEvent<E> {
	readonly event: E;
	readonly payload: unknown;
}

function passes<S, C>(transition: CompiledTransition<S, C>, context: C, payload: unknown): boolean {
	const guard = transition.guard;
	return guard === undefined || guard(context, payload);
}

export class StateMachine<S extends string, E extends string, C> {
	public readonly context: C;

	private readonly nodes: ReadonlyMap<S, StateNode<S, E, C>>;
	private readonly queue = new Array<QueuedEvent<E>>();
	private readonly listeners = new Array<Listener<S, E>>();
	private state: S;
	private node: StateNode<S, E, C>;
	private elapsed = 0;
	private busy = false;
	private destroyed = false;

	// built once per machine so pcall can run a step without a new closure every send/update
	private readonly sendStep = (event: E, payload: unknown): boolean => {
		const transitioned = this.handle(event, payload);
		this.drain();
		return transitioned;
	};

	private readonly updateStep = (dt: number): boolean => {
		this.elapsed += dt;

		const update = this.node.update;
		if (update !== undefined) {
			update(this.context, dt);
			// events raised during the frame win over a timer running out in the same frame
			this.drain();
			if (this.destroyed) {
				return false;
			}
		}

		// at most one timed transition per update. leftover time isn't carried into the next state, so a
		// long hitch can't skip through states nobody saw. if the hook's events already changed state, the
		// new state's timer started at 0 and can't have expired
		const after = this.node.after;
		if (after !== undefined && this.elapsed >= after.seconds) {
			this.transitionTo(after.target, undefined, undefined, undefined);
			this.drain();
			return true;
		}
		return false;
	};

	public constructor(definition: MachineDefinition<S, E, C>) {
		this.nodes = compileDefinition(definition);
		this.context = definition.context;
		this.state = definition.initial;
		this.node = this.nodes.get(this.state)!;

		const enter = this.node.enter;
		if (enter !== undefined) {
			enter(this.context, undefined, undefined);
		}
	}

	// from inside a hook, guard or listener the event is queued until the current transition finishes,
	// and false is returned
	public send(event: E, payload?: unknown): boolean {
		this.assertUsable();
		if (this.busy) {
			this.queue.push({ event, payload });
			return false;
		}
		return this.run(this.sendStep, event, payload);
	}

	public can(event: E, payload?: unknown): boolean {
		this.assertUsable();
		const transition = this.node.transitions.get(event);
		return transition !== undefined && passes(transition, this.context, payload);
	}

	public getState(): S {
		this.assertUsable();
		return this.state;
	}

	public is(state: S): boolean {
		this.assertUsable();
		return this.state === state;
	}

	public timeInState(): number {
		this.assertUsable();
		return this.elapsed;
	}

	public update(dt: number): void {
		this.assertUsable();
		if (!(dt >= 0 && dt < math.huge)) {
			throw `state machine update expects a finite dt >= 0, got ${dt}`;
		}
		if (this.busy) {
			throw "state machine update can't be called from inside one of its own callbacks";
		}
		this.run(this.updateStep, dt, undefined);
	}

	public onTransition(listener: TransitionListener<S, E>): () => void {
		this.assertUsable();
		const entry: Listener<S, E> = { callback: listener, connected: true };
		this.listeners.push(entry);

		return () => {
			if (!entry.connected) {
				return;
			}
			entry.connected = false;
			const index = this.listeners.indexOf(entry);
			if (index !== -1) {
				this.listeners.remove(index);
			}
		};
	}

	// no hooks run, not even the current state's exit
	public destroy(): void {
		if (this.destroyed) {
			return;
		}
		this.destroyed = true;
		for (const entry of this.listeners) {
			entry.connected = false;
		}
		this.listeners.clear();
		this.queue.clear();
	}

	private assertUsable(): void {
		if (this.destroyed) {
			throw "state machine was used after destroy()";
		}
	}

	private run<A, B>(step: (a: A, b: B) => boolean, a: A, b: B): boolean {
		this.busy = true;
		const [ok, result] = pcall(step, a, b);
		this.busy = false;
		// anything a failed step queued was a reaction to a transition that never finished, so it's dropped
		this.queue.clear();
		if (!ok) {
			error(result, 0);
		}
		return result as boolean;
	}

	private drain(): void {
		const queue = this.queue;
		// hooks run while draining can queue more, so the size is read again every pass
		let index = 0;
		while (index < queue.size() && !this.destroyed) {
			if (index >= MAX_QUEUED_EVENTS) {
				throw `state machine didn't settle after ${MAX_QUEUED_EVENTS} queued events, hooks are probably sending each other events in a loop`;
			}
			const queued = queue[index];
			this.handle(queued.event, queued.payload);
			index += 1;
		}
		queue.clear();
	}

	private handle(event: E, payload: unknown): boolean {
		const transition = this.node.transitions.get(event);
		if (transition === undefined || !passes(transition, this.context, payload)) {
			return false;
		}
		this.transitionTo(transition.target, event, payload, transition.action);
		return true;
	}

	private transitionTo(
		target: S,
		event: E | undefined,
		payload: unknown,
		action: ((context: C, payload: unknown) => void) | undefined,
	): void {
		const from = this.state;
		const context = this.context;

		// any hook can destroy the machine (an npc dying mid transition), and then the rest must not run
		const exit = this.node.exit;
		if (exit !== undefined) {
			exit(context, target);
			if (this.destroyed) {
				return;
			}
		}

		if (action !== undefined) {
			action(context, payload);
			if (this.destroyed) {
				return;
			}
		}

		this.state = target;
		this.node = this.nodes.get(target)!;
		this.elapsed = 0;

		const enter = this.node.enter;
		if (enter !== undefined) {
			enter(context, from, payload);
			if (this.destroyed) {
				return;
			}
		}

		if (this.listeners.isEmpty()) {
			return;
		}
		// a snapshot so listeners can connect or disconnect others while being called, the connected
		// flag covers the ones removed partway through
		for (const entry of table.clone(this.listeners)) {
			if (entry.connected) {
				entry.callback(from, target, event);
			}
		}
	}
}

export function createMachine<S extends string, E extends string, C>(
	definition: MachineDefinition<S, E, C>,
): StateMachine<S, E, C> {
	return new StateMachine(definition);
}
