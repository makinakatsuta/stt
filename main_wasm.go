//go:build js && wasm

package main

import (
	"math"
	"math/rand"
	"syscall/js"
)

const (
	CanvasWidth               = 800.0
	CanvasHeight              = 500.0
	TableLeft                 = 10.0
	TableRight                = CanvasWidth - 10.0
	PaddleWidth               = 100.0
	PaddleHeight              = 15.0
	BallRadius                = 10.0
	TableFriction             = 1.0
	YNet                      = 250.0
	YDefenseP1                = 400.0
	YDefenseP2                = 100.0
	NormalPaddleSpeed         = 8.0
	NormalCPUSpeed            = 5.2
	HardDifficultyFactor      = 0.9
	NormalOutSpeed            = 13.0
	EasyCPUDifficultyFactor   = 1.07
	EasyCPUReturnChance       = 0.90
	EasyRallyReturnLimit      = 8
	EasyRallyAcceleration     = 1.01
	StandardRallyAcceleration = 1.02
	HardRallyAcceleration     = 1.04
	EasyRallyMaxSpeed         = 8.0
	StandardRallyMaxSpeed     = 13.0
	HardRallyMaxSpeed         = 15.0
	EasySideOutChance         = 0.10
	NormalSideOutChance       = 0.15
	HardSideOutChance         = 0.20
)

func calculateRallyReturnVelocity(vx, vy, relativeHitPos float64, difficulty string, direction float64) (float64, float64) {
	incomingSpeed := math.Hypot(vx, vy)
	acceleration := StandardRallyAcceleration
	maxSpeed := StandardRallyMaxSpeed
	if difficulty == "easy" {
		acceleration = EasyRallyAcceleration
		maxSpeed = EasyRallyMaxSpeed
	} else if difficulty == "hard" {
		acceleration = HardRallyAcceleration
		maxSpeed = HardRallyMaxSpeed
	}
	targetSpeed := math.Min(incomingSpeed*acceleration, maxSpeed)
	// This function is used only for CPU hits; player returns are handled in JS.
	// Match the JS slow/fast mix and stay below Hard's 11.7 speed-out threshold.
	if difficulty == "hard" {
		targetSpeed = 5.0
		if rand.Float64() >= 0.5 {
			targetSpeed = 10.0
		}
		targetSpeed += rand.Float64() * 1.5
	}
	horizontalRatio := math.Max(-0.25, math.Min(0.25, relativeHitPos*0.25))
	outVx := targetSpeed * horizontalRatio
	outVy := direction * math.Sqrt(math.Max(0, targetSpeed*targetSpeed-outVx*outVx))
	return outVx, outVy
}

func normalCpuVelocity(ball js.Value, x, direction float64) (float64, float64) {
	dx := ball.Get("normalTargetX").Float() - x
	dy := YDefenseP1 - YDefenseP2
	scale := ball.Get("normalSpeed").Float() / math.Hypot(dx, dy)
	return dx * scale, direction * dy * scale
}

func main() {
	// Register the function to JavaScript global scope
	js.Global().Set("updatePhysicsWasm", js.FuncOf(updatePhysicsWasm))

	// Keep the Go program running
	select {}
}

func getBoolSafe(v js.Value, key string) bool {
	val := v.Get(key)
	if val.Type() == js.TypeBoolean {
		return val.Bool()
	}
	return false
}

func predictedBallX(x, y, vx, vy, defenseY float64) float64 {
	if math.Abs(vy) < 0.01 {
		return x
	}
	frames := (defenseY - y) / vy
	if frames < 0 {
		frames = 0
	}
	// 800px の横幅とボール半径を使った折り返し座標で壁反射を先読みする。
	minX := BallRadius
	span := (CanvasWidth - BallRadius) - minX
	target := x + vx*frames
	reflected := math.Mod(math.Mod(target-minX, span*2)+span*2, span*2)
	if reflected > span {
		reflected = span*2 - reflected
	}
	return minX + reflected
}

func updatePhysicsWasm(this js.Value, args []js.Value) interface{} {
	if len(args) < 9 {
		return nil
	}

	// Extract arguments
	jsBall := args[0]
	jsP1 := args[1]
	jsP2 := args[2]
	jsKeys := args[3]
	mode := args[4].String()
	state := args[5].String()
	role := args[6].Int()
	difficulty := args[7].String()
	timeMs := args[8].Float() // Date.now() as float

	// Get ball properties
	ballX := jsBall.Get("x").Float()
	ballY := jsBall.Get("y").Float()
	ballVx := jsBall.Get("vx").Float()
	ballVy := jsBall.Get("vy").Float()
	ballActive := jsBall.Get("active").Bool()
	easyCpuAttempted := getBoolSafe(jsBall, "easyCpuAttempted")
	normalCpuAttempted := getBoolSafe(jsBall, "normalCpuAttempted")
	hardCpuAttempted := getBoolSafe(jsBall, "hardCpuAttempted")
	easyReturnCount := 0
	if value := jsBall.Get("easyReturnCount"); value.Type() == js.TypeNumber {
		easyReturnCount = value.Int()
	}
	canCpuReturn := func() bool {
		if difficulty == "hard" {
			if hardCpuAttempted {
				return false
			}
			hardCpuAttempted = true
			return true
		}
		if difficulty == "normal" {
			if normalCpuAttempted {
				return false
			}
			normalCpuAttempted = true
			return true
		}
		if difficulty != "easy" {
			return true
		}
		if easyCpuAttempted {
			return false
		}
		easyCpuAttempted = true
		return easyReturnCount < EasyRallyReturnLimit-1
	}
	// Get paddle properties
	p1X := jsP1.Get("x").Float()
	p2X := jsP2.Get("x").Float()

	// 1. Player paddle movement (Keys)
	// Normal / Hard はラリー中にボール速度が上がるため、移動量ではなく
	// ラケットの移動速度を難易度に応じて上げ、左右の深い球にも追いつけるようにする。
	paddleSpeed := 8.5
	switch difficulty {
	case "normal":
		paddleSpeed = NormalPaddleSpeed
	case "hard":
		paddleSpeed = NormalPaddleSpeed * HardDifficultyFactor
	}
	if len(args) > 9 && args[9].Type() == js.TypeNumber {
		paddleSpeed *= math.Max(0, math.Min(1, args[9].Float()))
	}
	if role == 1 {
		if getBoolSafe(jsKeys, "ArrowLeft") {
			p1X -= paddleSpeed
			if p1X < TableLeft {
				p1X = TableLeft
			}
		}
		if getBoolSafe(jsKeys, "ArrowRight") {
			p1X += paddleSpeed
			if p1X > TableRight-PaddleWidth {
				p1X = TableRight - PaddleWidth
			}
		}
	} else if role == 2 {
		if getBoolSafe(jsKeys, "ArrowLeft") {
			p2X -= paddleSpeed
			if p2X < TableLeft {
				p2X = TableLeft
			}
		}
		if getBoolSafe(jsKeys, "ArrowRight") {
			p2X += paddleSpeed
			if p2X > TableRight-PaddleWidth {
				p2X = TableRight - PaddleWidth
			}
		}
	}

	// 2. CPU AI movement
	if mode == "cpu" && state == "RALLY" && ((role == 1 && ballVy < 0) || (role == 2 && ballVy > 0)) {
		cpuX := &p2X
		defenseY := YDefenseP2
		if role == 2 {
			cpuX = &p1X
			defenseY = YDefenseP1
		}
		cpuSpeed := 4.5
		targetOffset := 0.0

		switch difficulty {
		case "easy":
			cpuSpeed = 4.05 * EasyCPUDifficultyFactor
			targetOffset = math.Sin(timeMs/600.0) * 8.0
		case "normal":
			cpuSpeed = NormalCPUSpeed
			targetOffset = math.Sin(timeMs/600.0) * 6.0
		case "hard":
			cpuSpeed = 7.65
			targetOffset = 0.0
		}

		// CPU も現在位置ではなく、ラケット到達時の玉の位置を追う。
		predictedX := predictedBallX(ballX, ballY, ballVx, ballVy, defenseY)
		cpuTarget := predictedX - PaddleWidth/2.0 + targetOffset
		if difficulty == "normal" {
			cpuSpeed = math.Min(cpuSpeed, math.Abs(cpuTarget-*cpuX))
		}

		if *cpuX < cpuTarget {
			*cpuX += cpuSpeed
			if *cpuX > TableRight-PaddleWidth {
				*cpuX = TableRight - PaddleWidth
			}
		} else if *cpuX > cpuTarget {
			*cpuX -= cpuSpeed
			if *cpuX < TableLeft {
				*cpuX = TableLeft
			}
		}
	}

	// List of events that occurred in this update frame
	events := []interface{}{}

	// 3. Ball movement & collision detection
	if ballActive && state == "RALLY" {
		ballVx *= TableFriction
		ballVy *= TableFriction

		oldBallY := ballY

		ballX += ballVx
		ballY += ballVy

		// --- Left/Right wall bounce ---
		sideOut := false
		if ballX-BallRadius <= 0 {
			ballX = BallRadius
			sideOutChance := NormalSideOutChance
			if difficulty == "easy" {
				sideOutChance = EasySideOutChance
			} else if difficulty == "hard" {
				sideOutChance = HardSideOutChance
			}
			if rand.Float64() < sideOutChance {
				sideOut = true
				winner := 1
				if ballVy < 0 {
					winner = 2
				}
				events = append(events, map[string]interface{}{"type": "score", "winner": winner, "reason": "out"})
			} else {
				ballVx = -ballVx * 0.85
				events = append(events, map[string]interface{}{
					"type": "wall_hit",
					"x":    ballX,
					"y":    ballY,
				})
			}
		} else if ballX+BallRadius >= CanvasWidth {
			ballX = CanvasWidth - BallRadius
			sideOutChance := NormalSideOutChance
			if difficulty == "easy" {
				sideOutChance = EasySideOutChance
			} else if difficulty == "hard" {
				sideOutChance = HardSideOutChance
			}
			if rand.Float64() < sideOutChance {
				sideOut = true
				winner := 1
				if ballVy < 0 {
					winner = 2
				}
				events = append(events, map[string]interface{}{"type": "score", "winner": winner, "reason": "out"})
			} else {
				ballVx = -ballVx * 0.85
				events = append(events, map[string]interface{}{
					"type": "wall_hit",
					"x":    ballX,
					"y":    ballY,
				})
			}
		}

		// --- Net collision (chance-based bounce) ---
		wasAboveNet := oldBallY < YNet
		isBelowNet := ballY >= YNet
		if !sideOut && wasAboveNet != isBelowNet && math.Abs(ballVx) > 8 {
			if rand.Float64() < 0.25 {
				ballVy = -ballVy * 0.3
				ballVx *= 0.5
				events = append(events, map[string]interface{}{
					"type": "net_hit",
					"x":    ballX,
					"y":    ballY,
				})
			}
		}

		// --- Player 1 (Bottom/Self) Paddle hit ---
		if !sideOut && ballVy > 0 && ballY >= YDefenseP1 && ballY <= YDefenseP1+25 {
			isP1Cpu := (mode == "cpu" && role == 2)
			if isP1Cpu {
				hitPaddle := ballX >= p1X && ballX <= p1X+PaddleWidth
				cpuReturnChance := 0.88
				if difficulty == "easy" {
					cpuReturnChance = EasyCPUReturnChance
					if easyReturnCount < 2 {
						cpuReturnChance = 1
					}
				} else if difficulty == "normal" {
					cpuReturnChance = jsBall.Get("normalReturnChance").Float()
				}
				if canCpuReturn() && hitPaddle && rand.Float64() < cpuReturnChance {
					ballY = YDefenseP1
					relativeHitPos := (ballX - (p1X + PaddleWidth/2.0)) / (PaddleWidth / 2.0)
					ballVx, ballVy = calculateRallyReturnVelocity(ballVx, ballVy, relativeHitPos, difficulty, -1)
					if difficulty == "normal" {
						ballVx, ballVy = normalCpuVelocity(jsBall, ballX, -1)
					}

					events = append(events, map[string]interface{}{
						"type":   "ball_hit",
						"player": 1,
						"x":      ballX,
						"y":      ballY,
						"vx":     ballVx,
						"vy":     ballVy,
					})
				}
			}
		}

		// --- Player 2 (Top/Opponent) Paddle hit ---
		if !sideOut && ballVy < 0 && ballY <= YDefenseP2 && ballY >= YDefenseP2-25 {
			isP2Cpu := (mode == "cpu" && role == 1)
			if isP2Cpu {
				hitPaddle := ballX >= p2X && ballX <= p2X+PaddleWidth
				cpuReturnChance := 0.88
				if difficulty == "easy" {
					cpuReturnChance = EasyCPUReturnChance
					if easyReturnCount < 2 {
						cpuReturnChance = 1
					}
				} else if difficulty == "normal" {
					cpuReturnChance = jsBall.Get("normalReturnChance").Float()
				}
				if canCpuReturn() && hitPaddle && rand.Float64() < cpuReturnChance {
					ballY = YDefenseP2
					relativeHitPos := (ballX - (p2X + PaddleWidth/2.0)) / (PaddleWidth / 2.0)
					ballVx, ballVy = calculateRallyReturnVelocity(ballVx, ballVy, relativeHitPos, difficulty, 1)
					if difficulty == "normal" {
						ballVx, ballVy = normalCpuVelocity(jsBall, ballX, 1)
					}

					events = append(events, map[string]interface{}{
						"type":   "ball_hit",
						"player": 2,
						"x":      ballX,
						"y":      ballY,
						"vx":     ballVx,
						"vy":     ballVy,
					})
				}
			}
		}

		// --- Endline / Safe / Out & Score detection (STT rulebook compliant) ---
		if !sideOut && ballY > CanvasHeight {
			outSpeed := NormalOutSpeed
			if difficulty == "hard" {
				outSpeed *= HardDifficultyFactor
			}
			if math.Abs(ballVy) > outSpeed {
				events = append(events, map[string]interface{}{
					"type":   "score",
					"winner": 1,
					"reason": "out",
				})
			} else {
				events = append(events, map[string]interface{}{
					"type":   "score",
					"winner": 2,
					"reason": "safe",
				})
			}
		} else if !sideOut && ballY < 0 {
			outSpeed := NormalOutSpeed
			if difficulty == "hard" {
				outSpeed *= HardDifficultyFactor
			}
			if math.Abs(ballVy) > outSpeed {
				events = append(events, map[string]interface{}{
					"type":   "score",
					"winner": 2,
					"reason": "out",
				})
			} else {
				events = append(events, map[string]interface{}{
					"type":   "score",
					"winner": 1,
					"reason": "safe",
				})
			}
		} else if !sideOut {
			// Stopping detection (loss by friction)
			ballSpeed := math.Sqrt(ballVx*ballVx + ballVy*ballVy)
			if ballSpeed < 0.12 {
				ballVx = 0.0
				ballVy = 0.0
				ballActive = false // Deactivate ball

				var winner int
				var reason string
				if ballY >= YDefenseP1 {
					winner = 2
					reason = "stop"
				} else if ballY <= YDefenseP2 {
					winner = 1
					reason = "stop"
				} else {
					if ballY > YNet {
						winner = 2
					} else {
						winner = 1
					}
					reason = "front_stop"
				}
				events = append(events, map[string]interface{}{
					"type":   "score",
					"winner": winner,
					"reason": reason,
				})
			}
		}
	}

	// Prepare results object
	res := map[string]interface{}{
		"ball": map[string]interface{}{
			"x":                  ballX,
			"y":                  ballY,
			"vx":                 ballVx,
			"vy":                 ballVy,
			"active":             ballActive,
			"easyCpuAttempted":   easyCpuAttempted,
			"normalCpuAttempted": normalCpuAttempted,
			"hardCpuAttempted":   hardCpuAttempted,
		},
		"p1": map[string]interface{}{
			"x": p1X,
		},
		"p2": map[string]interface{}{
			"x": p2X,
		},
		"events": events,
	}

	return res
}
