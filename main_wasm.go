//go:build js && wasm

package main

import (
	"math"
	"math/rand"
	"syscall/js"
	"time"
)

const (
	CanvasWidth   = 800.0
	CanvasHeight  = 500.0
	PaddleWidth   = 100.0
	PaddleHeight  = 15.0
	BallRadius    = 10.0
	TableFriction = 0.992
	YNet          = 250.0
	YDefenseP1    = 400.0
	YDefenseP2    = 100.0
)

func main() {
	// Initialize random seed
	rand.Seed(time.Now().UnixNano())

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

	// Get paddle properties
	p1X := jsP1.Get("x").Float()
	p2X := jsP2.Get("x").Float()

	// 1. Player paddle movement (Keys)
	paddleSpeed := 7.0
	if role == 1 {
		if getBoolSafe(jsKeys, "ArrowLeft") || getBoolSafe(jsKeys, "KeyA") {
			p1X -= paddleSpeed
			if p1X < 0 {
				p1X = 0
			}
		}
		if getBoolSafe(jsKeys, "ArrowRight") || getBoolSafe(jsKeys, "KeyD") {
			p1X += paddleSpeed
			if p1X > CanvasWidth-PaddleWidth {
				p1X = CanvasWidth - PaddleWidth
			}
		}
	} else if role == 2 {
		if getBoolSafe(jsKeys, "ArrowLeft") || getBoolSafe(jsKeys, "KeyA") {
			p2X -= paddleSpeed
			if p2X < 0 {
				p2X = 0
			}
		}
		if getBoolSafe(jsKeys, "ArrowRight") || getBoolSafe(jsKeys, "KeyD") {
			p2X += paddleSpeed
			if p2X > CanvasWidth-PaddleWidth {
				p2X = CanvasWidth - PaddleWidth
			}
		}
	}

	// 2. CPU AI movement
	if mode == "cpu" && state == "RALLY" && ballVy < 0 {
		cpuSpeed := 5.0
		targetOffset := 0.0

		switch difficulty {
		case "easy":
			cpuSpeed = 3.0
			targetOffset = math.Sin(timeMs/150.0) * 45.0
		case "normal":
			cpuSpeed = 5.2
			targetOffset = math.Sin(timeMs/300.0) * 15.0
		case "hard":
			cpuSpeed = 8.5
			targetOffset = 0.0
		}

		cpuTarget := ballX - PaddleWidth/2.0 + targetOffset

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
				hitPaddle := ballX >= p1X && ballX <= p1X+PaddleWidth
				if hitPaddle {
					ballY = YDefenseP1
					relativeHitPos := (ballX - (p1X + PaddleWidth/2.0)) / (PaddleWidth / 2.0)
					ballVx = relativeHitPos * 4.0
					ballVy = -math.Abs(ballVy) * 1.05

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
				hitPaddle := ballX >= p2X && ballX <= p2X+PaddleWidth
				if hitPaddle {
					ballY = YDefenseP2
					relativeHitPos := (ballX - (p2X + PaddleWidth/2.0)) / (PaddleWidth / 2.0)
					ballVx = relativeHitPos * 4.0
					ballVy = math.Abs(ballVy) * 1.05

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

		// --- Endline / Out & Score detection ---
		if ballY > CanvasHeight {
			events = append(events, map[string]interface{}{
				"type":   "score",
				"winner": 2,
				"reason": "miss",
			})
		} else if ballY < 0 {
			events = append(events, map[string]interface{}{
				"type":   "score",
				"winner": 1,
				"reason": "miss",
			})
		} else {
			// Stopping detection (loss by friction)
			ballSpeed := math.Sqrt(ballVx*ballVx + ballVy*ballVy)
			if ballSpeed < 0.12 {
				ballVx = 0.0
				ballVy = 0.0
				ballActive = false // Deactivate ball
				var winner int
				if ballY > YNet {
					winner = 2
				} else {
					winner = 1
				}
				events = append(events, map[string]interface{}{
					"type":   "score",
					"winner": winner,
					"reason": "stop",
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
