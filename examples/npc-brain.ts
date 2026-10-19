import { Players, RunService, Workspace } from "@rbxts/services";
import { createMachine } from "@skyzwrl/state-machine";

// idle <-> patrol -> chase <-> attack, with stunned and dead reachable from any of them.
// sensing lives outside the machine: every frame it reports what it sees as events and the current
// state decides what they mean (chase reacts to inRange, stunned ignores it)

const SIGHT_RANGE = 60;
const LOSE_RANGE = 90;
const ATTACK_RANGE = 6;
const ATTACK_DAMAGE = 15;
const ATTACK_COOLDOWN = 1.2;
const REPATH_INTERVAL = 0.25;

interface Brain {
	readonly humanoid: Humanoid;
	readonly root: BasePart;
	readonly sight: RaycastParams;
	readonly waypoints: Vector3[];
	waypoint: number;
	target?: BasePart;
	walking?: RBXScriptConnection;
	repathIn: number;
	attackCooldown: number;
}

function humanoidOf(part: BasePart) {
	return part.Parent?.FindFirstChildOfClass("Humanoid");
}

function isAlive(part: BasePart) {
	const humanoid = humanoidOf(part);
	return humanoid !== undefined && humanoid.Health > 0 && part.IsDescendantOf(Workspace);
}

function findTarget(origin: Vector3) {
	let closest: BasePart | undefined;
	let closestDistance = SIGHT_RANGE;

	for (const player of Players.GetPlayers()) {
		const root = player.Character?.FindFirstChild("HumanoidRootPart");
		if (root?.IsA("BasePart") && isAlive(root)) {
			const distance = root.Position.sub(origin).Magnitude;
			if (distance < closestDistance) {
				closest = root;
				closestDistance = distance;
			}
		}
	}
	return closest;
}

function canSee(brain: Brain, target: BasePart) {
	const origin = brain.root.Position;
	const hit = Workspace.Raycast(origin, target.Position.sub(origin), brain.sight);
	return hit === undefined || (target.Parent !== undefined && hit.Instance.IsDescendantOf(target.Parent));
}

function stop(brain: Brain) {
	brain.humanoid.MoveTo(brain.root.Position);
}

function walkToWaypoint(brain: Brain) {
	brain.humanoid.MoveTo(brain.waypoints[brain.waypoint]);
}

const chaseOnSight = {
	target: "chase" as const,
	guard: (brain: Brain, spotted: unknown) =>
		typeIs(spotted, "Instance") && spotted.IsA("BasePart") && canSee(brain, spotted),
	action: (brain: Brain, spotted: unknown) => {
		brain.target = spotted as BasePart;
	},
};

export function attachBrain(model: Model, waypoints: Vector3[]): () => void {
	const humanoid = model.FindFirstChildOfClass("Humanoid");
	const root = model.PrimaryPart;
	assert(humanoid && root, `${model.GetFullName()} needs a Humanoid and a PrimaryPart`);
	assert(!waypoints.isEmpty(), "an npc brain needs at least one patrol waypoint");

	const sight = new RaycastParams();
	sight.FilterType = Enum.RaycastFilterType.Exclude;
	sight.FilterDescendantsInstances = [model];

	const brain: Brain = { humanoid, root, sight, waypoints, waypoint: 0, repathIn: 0, attackCooldown: 0 };

	const machine = createMachine({
		initial: "idle",
		context: brain,
		states: {
			idle: {
				enter: stop,
				on: {
					spotted: chaseOnSight,
					// reached with a target still remembered, like when a stun wears off mid fight
					outOfRange: "chase",
					inRange: "attack",
					hit: "stunned",
					died: "dead",
				},
				after: { seconds: 3, target: "patrol" },
			},

			patrol: {
				enter: (context) => {
					walkToWaypoint(context);
					context.walking = context.humanoid.MoveToFinished.Connect((reached) => {
						if (reached) {
							context.waypoint = (context.waypoint + 1) % context.waypoints.size();
						}
						// MoveTo gives up after 8 seconds, so an unreached waypoint just gets retried
						walkToWaypoint(context);
					});
				},
				exit: (context) => {
					context.walking?.Disconnect();
					context.walking = undefined;
				},
				on: { spotted: chaseOnSight, hit: "stunned", died: "dead" },
				after: { seconds: 30, target: "idle" },
			},

			chase: {
				enter: (context) => {
					context.repathIn = 0;
				},
				update: (context, dt) => {
					context.repathIn -= dt;
					if (context.target && context.repathIn <= 0) {
						context.repathIn = REPATH_INTERVAL;
						context.humanoid.MoveTo(context.target.Position);
					}
				},
				on: { inRange: "attack", lost: "idle", hit: "stunned", died: "dead" },
			},

			attack: {
				enter: stop,
				update: (context, dt) => {
					// only runs down while attacking and isn't reset on entry, so stepping in and out of
					// range can't skip the cooldown
					context.attackCooldown -= dt;
					if (context.target && context.attackCooldown <= 0) {
						context.attackCooldown = ATTACK_COOLDOWN;
						humanoidOf(context.target)?.TakeDamage(ATTACK_DAMAGE);
					}
				},
				on: { outOfRange: "chase", lost: "idle", hit: "stunned", died: "dead" },
			},

			stunned: {
				enter: stop,
				// getting hit again is a self transition, which restarts the stun timer
				on: { hit: "stunned", died: "dead" },
				after: { seconds: 1.5, target: "idle" },
			},

			dead: {},
		},
	});

	// everything is checked at compile time, both of these are errors:
	//   machine.send("spoted")  -> Argument of type '"spoted"' is not assignable to parameter of type ...
	//   on: { lost: "idel" }    -> Type '"idel"' is not assignable to type ... Did you mean '"idle"'?

	const sense = () => {
		if (humanoid.Health <= 0) {
			return;
		}

		const target = brain.target;
		if (target === undefined) {
			const spotted = findTarget(root.Position);
			if (spotted) {
				machine.send("spotted", spotted);
			}
			return;
		}

		const distance = target.Position.sub(root.Position).Magnitude;
		if (!isAlive(target) || distance > LOSE_RANGE) {
			brain.target = undefined;
			machine.send("lost");
		} else if (distance <= ATTACK_RANGE) {
			machine.send("inRange");
		} else {
			machine.send("outOfRange");
		}
	};

	let lastHealth = humanoid.Health;
	const healthChanged = humanoid.HealthChanged.Connect((health) => {
		if (health < lastHealth && health > 0) {
			machine.send("hit");
		}
		lastHealth = health;
	});
	const died = humanoid.Died.Connect(() => machine.send("died"));
	const heartbeat = RunService.Heartbeat.Connect((dt) => {
		sense();
		machine.update(dt);
	});

	return () => {
		heartbeat.Disconnect();
		healthChanged.Disconnect();
		died.Disconnect();
		// destroy() skips exit hooks, so let go of whatever patrol is still holding
		brain.walking?.Disconnect();
		brain.walking = undefined;
		machine.destroy();
	};
}
