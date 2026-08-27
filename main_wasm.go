//go:build js && wasm

package main

import (
	"math"
	"math/rand"
	"syscall/js"
)

const (
	CanvasWidth   = 800.0
	CanvasHeight  = 500.0
	PaddleWidth   = 100.0
	PaddleHeight  = 15.0
	BallRadius    = 10.0
	TableFriction = 0.997
	YNet          = 250.0
	YDefenseP1    = 400.0
	YDefenseP2    = 100.0
)

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
	easyGuaranteedReturns := jsBall.Get("easyGuaranteedReturns").Int()

	// Get paddle properties
	p1X := jsP1.Get("x").Float()
	p2X := jsP2.Get("x").Float()

	// 1. Player paddle movement (Keys)
	// Normal / Hard はラリー中にボール速度が上がるため、移動量ではなく
	// ラケットの移動速度を難易度に応じて上げ、左右の深い球にも追いつけるようにする。
	paddleSpeed := 7.0
	switch difficulty {
	case "normal":
		paddleSpeed = 8.0
	case "hard":
		paddleSpeed = 9.0
	}
	if role == 1 {
		if getBoolSafe(jsKeys, "ArrowLeft") {
			p1X -= paddleSpeed
			if p1X < 0 {
				p1X = 0
			}
		}
		if getBoolSafe(jsKeys, "ArrowRight") {
			p1X += paddleSpeed
			if p1X > CanvasWidth-PaddleWidth {
				p1X = CanvasWidth - PaddleWidth
			}
		}
	} else if role == 2 {
		if getBoolSafe(jsKeys, "ArrowLeft") {
			p2X -= paddleSpeed
			if p2X < 0 {
				p2X = 0
			}
		}
		if getBoolSafe(jsKeys, "ArrowRight") {
			p2X += paddleSpeed
			if p2X > CanvasWidth-PaddleWidth {
				p2X = CanvasWidth - PaddleWidth
			}
		}
	}

	// 2. CPU AI movement
	if mode == "cpu" && state == "RALLY" && ballVy < 0 {
		cpuSpeed := 4.5
		targetOffset := 0.0

		switch difficulty {
		case "easy":
			cpuSpeed = 4.05
			targetOffset = math.Sin(timeMs/600.0) * 8.0
		case "normal":
			cpuSpeed = 4.68
			targetOffset = math.Sin(timeMs/300.0) * 15.0
		case "hard":
			cpuSpeed = 7.65
			targetOffset = 0.0
		}

		// CPU も現在位置ではなく、ラケット到達時の玉の位置を追う。
		predictedX := predictedBallX(ballX, ballY, ballVx, ballVy, YDefenseP2)
		cpuTarget := predictedX - PaddleWidth/2.0 + targetOffset

		if p2X < cpuTarget {
			p2X += cpuSpeed
			if p2X > CanvasWidth-PaddleWidth {
				p2X = CanvasWidth - PaddleWidth
			}
		} else if p2X > cpuTarget {
			p2X -= cpuSpeed
			if p2X < 0 {
				p2X = 0
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
		if ballX-BallRadius <= 0 {
			ballX = BallRadius
			ballVx = -ballVx * 0.85
			events = append(events, map[string]interface{}{
				"type": "wall_hit",
				"x":    ballX,
				"y":    ballY,
			})
		} else if ballX+BallRadius >= CanvasWidth {
			ballX = CanvasWidth - BallRadius
			ballVx = -ballVx * 0.85
			events = append(events, map[string]interface{}{
				"type": "wall_hit",
				"x":    ballX,
				"y":    ballY,
			})
		}

		// --- Net collision (chance-based bounce) ---
		wasAboveNet := oldBallY < YNet
		isBelowNet := ballY >= YNet
		if wasAboveNet != isBelowNet && math.Abs(ballVx) > 8 {
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
		if ballVy > 0 && ballY >= YDefenseP1 && ballY <= YDefenseP1+25 {
			isP1Cpu := (mode == "cpu" && role == 2)
			if isP1Cpu {
				easyGuaranteeActive := difficulty == "easy" && easyGuaranteedReturns < 3
				if easyGuaranteeActive {
					p1X = math.Max(0, math.Min(CanvasWidth-PaddleWidth, ballX-PaddleWidth/2.0))
				}
				hitPaddle := ballX >= p1X && ballX <= p1X+PaddleWidth
				if hitPaddle {
					ballY = YDefenseP1
					relativeHitPos := (ballX - (p1X + PaddleWidth/2.0)) / (PaddleWidth / 2.0)
					cpuVxFactor := 3.6
					cpuVyBoost := 1.045
					if difficulty == "easy" {
						cpuVxFactor = 1.35
						cpuVyBoost = 1.018
					} else if difficulty == "hard" {
						cpuVxFactor = 5.4
						cpuVyBoost = 1.144
					}
					easySpeedFactor := 1.0
					if difficulty == "easy" {
						easySpeedFactor = 0.8
					}
					ballVx = relativeHitPos * cpuVxFactor * easySpeedFactor
					ballVy = -math.Abs(ballVy) * cpuVyBoost * easySpeedFactor
					if easyGuaranteeActive {
						easyGuaranteedReturns++
						jsBall.Set("easyGuaranteedReturns", easyGuaranteedReturns)
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
		if ballVy < 0 && ballY <= YDefenseP2 && ballY >= YDefenseP2-25 {
			isP2Cpu := (mode == "cpu" && role == 1)
			if isP2Cpu {
				easyGuaranteeActive := difficulty == "easy" && easyGuaranteedReturns < 3
				if easyGuaranteeActive {
					p2X = math.Max(0, math.Min(CanvasWidth-PaddleWidth, ballX-PaddleWidth/2.0))
				}
				hitPaddle := ballX >= p2X && ballX <= p2X+PaddleWidth
				if hitPaddle {
					ballY = YDefenseP2
					relativeHitPos := (ballX - (p2X + PaddleWidth/2.0)) / (PaddleWidth / 2.0)
					cpuVxFactor := 3.6
					cpuVyBoost := 1.045
					if difficulty == "easy" {
						cpuVxFactor = 1.35
						cpuVyBoost = 1.018
					} else if difficulty == "hard" {
						cpuVxFactor = 5.4
						cpuVyBoost = 1.144
					}
					easySpeedFactor := 1.0
					if difficulty == "easy" {
						easySpeedFactor = 0.8
					}
					ballVx = relativeHitPos * cpuVxFactor * easySpeedFactor
					ballVy = math.Abs(ballVy) * cpuVyBoost * easySpeedFactor
					if easyGuaranteeActive {
						easyGuaranteedReturns++
						jsBall.Set("easyGuaranteedReturns", easyGuaranteedReturns)
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
		if ballY > CanvasHeight {
			if math.Abs(ballVy) > 13.0 {
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
		} else if ballY < 0 {
			if math.Abs(ballVy) > 13.0 {
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
		} else {
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
			"x":      ballX,
			"y":      ballY,
			"vx":     ballVx,
			"vy":     ballVy,
			"active": ballActive,
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
