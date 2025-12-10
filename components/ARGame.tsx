import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { generateSound } from '../utils/sound';

declare global {
  interface Window {
    Hands: any;
    drawConnectors: any;
    drawLandmarks: any;
    HAND_CONNECTIONS: any;
  }
}

interface ARGameProps {
  gameState: number;
  onScoreUpdate: (score: number) => void;
  onGameOver: (score: number) => void;
}

const MP_HANDS_VERSION = '0.4.1646424915';

export default function ARGame({ gameState, onScoreUpdate, onGameOver }: ARGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackingCanvasRef = useRef<HTMLCanvasElement>(null);
  
  // Game Logic Refs
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const targetsRef = useRef<THREE.Group[]>([]);
  const laserRef = useRef<THREE.Line | null>(null);
  const reticleRef = useRef<THREE.Group | null>(null);
  const scoreRef = useRef(0);
  const isTriggeredRef = useRef(false);
  const lastShotTimeRef = useRef(0);
  const latestLandmarksRef = useRef<any>(null);
  const handsRef = useRef<any>(null);
  const processingRef = useRef(false); // Throttling flag
  
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [floatingTexts, setFloatingTexts] = useState<{id: number, x: number, y: number, text: string, type: 'hit' | 'miss'}[]>([]);

  const addFloatingText = (x: number, y: number, text: string, type: 'hit' | 'miss') => {
    const id = Date.now() + Math.random();
    setFloatingTexts(prev => [...prev, { id, x, y, text, type }]);
    setTimeout(() => {
      setFloatingTexts(prev => prev.filter(ft => ft.id !== id));
    }, 800);
  };

  useEffect(() => {
    if (!containerRef.current || !canvasRef.current) return;

    let animationFrameId: number;
    let clock = new THREE.Clock();

    // --- Three.js Setup ---
    const width = window.innerWidth;
    const height = window.innerHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1923); // Default Valorant Blue-Black
    scene.fog = new THREE.FogExp2(0x0f1923, 0.02);

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xff4655, 1.5);
    dirLight.position.set(-5, 5, 5);
    scene.add(dirLight);

    // Camera
    const aspect = width / height;
    const threeCamera = new THREE.PerspectiveCamera(60, aspect, 0.1, 1000);
    threeCamera.position.z = 10; 

    // Renderer
    const renderer = new THREE.WebGLRenderer({ 
      canvas: canvasRef.current, 
      alpha: true,
      antialias: true,
      powerPreference: "high-performance"
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    sceneRef.current = scene;
    cameraRef.current = threeCamera;
    rendererRef.current = renderer;

    // --- Assets ---
    
    // Grid Floor (Visible when camera is off or as overlay)
    const gridHelper = new THREE.GridHelper(100, 40, 0xff4655, 0x334155);
    gridHelper.position.y = -10;
    scene.add(gridHelper);

    // Laser Line
    const laserMaterial = new THREE.LineBasicMaterial({ 
      color: 0xff4655, 
      linewidth: 2, 
      transparent: true, 
      opacity: 0.8,
      blending: THREE.AdditiveBlending
    });
    const laserGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,-100)]);
    const laserLine = new THREE.Line(laserGeometry, laserMaterial);
    laserLine.frustumCulled = false;
    scene.add(laserLine);
    laserRef.current = laserLine;

    // Reticle
    const reticleGroup = new THREE.Group();
    const reticleRingGeo = new THREE.RingGeometry(0.15, 0.18, 32);
    const reticleMat = new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.9, depthTest: false });
    const reticleRing = new THREE.Mesh(reticleRingGeo, reticleMat);
    reticleGroup.add(reticleRing);
    
    const crosshairGeo = new THREE.PlaneGeometry(0.6, 0.04);
    const crosshairMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false });
    const crossV = new THREE.Mesh(crosshairGeo, crosshairMat);
    const crossH = new THREE.Mesh(crosshairGeo, crosshairMat);
    crossH.rotation.z = Math.PI / 2;
    const left = crossV.clone(); left.position.x = -0.4;
    const right = crossV.clone(); right.position.x = 0.4;
    const top = crossH.clone(); top.position.y = 0.4;
    const bottom = crossH.clone(); bottom.position.y = -0.4;
    reticleGroup.add(left, right, top, bottom);
    scene.add(reticleGroup);
    reticleRef.current = reticleGroup;

    // Video Texture Setup
    let videoTexture: THREE.VideoTexture | null = null;
    if (videoRef.current) {
        videoTexture = new THREE.VideoTexture(videoRef.current);
        videoTexture.colorSpace = THREE.SRGBColorSpace;
        videoTexture.minFilter = THREE.LinearFilter;
        videoTexture.magFilter = THREE.LinearFilter;
    }

    // --- Spawner ---
    const spawnTarget = () => {
      const group = new THREE.Group();
      
      // Core
      const coreGeo = new THREE.IcosahedronGeometry(0.6, 0);
      const coreMat = new THREE.MeshStandardMaterial({ 
        color: 0x00ffff, 
        emissive: 0x008888,
        emissiveIntensity: 0.5,
        roughness: 0.2,
        metalness: 0.8,
        flatShading: true
      });
      const core = new THREE.Mesh(coreGeo, coreMat);
      group.add(core);

      // Ring
      const ringGeo = new THREE.TorusGeometry(0.9, 0.05, 8, 32);
      const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      group.add(ring);

      const spawnDist = 18;
      const angle = Math.random() * Math.PI * 2;
      group.position.set(
        Math.cos(angle) * spawnDist,
        (Math.random() - 0.5) * 8, 
        -20 
      );
      
      group.lookAt(0, 0, 0);
      
      group.userData = {
        velocity: new THREE.Vector3().subVectors(new THREE.Vector3(0,0,5), group.position).normalize().multiplyScalar(4 + Math.random() * 2),
        active: true,
        rotSpeed: (Math.random() - 0.5) * 4
      };
      
      scene.add(group);
      targetsRef.current.push(group);
    };

    // --- Game Loop ---
    const loop = async () => {
      if (!sceneRef.current || !cameraRef.current || !rendererRef.current) return;
      
      const dt = clock.getDelta();

      // 1. Process Video & MediaPipe
      if (videoRef.current && videoRef.current.readyState >= 2) {
        // Update background if video is playing
        if (scene.background instanceof THREE.Color) {
           if (videoTexture) scene.background = videoTexture;
           setCameraReady(true);
        }

        // Send to MediaPipe (throttled)
        if (handsRef.current && !processingRef.current) {
          processingRef.current = true;
          // Fire and forget to not block render loop
          handsRef.current.send({image: videoRef.current})
            .then(() => { processingRef.current = false; })
            .catch(() => { processingRef.current = false; });
        }
      }

      // 2. Game Logic
      if (gameState === 1) { // Playing
        if (targetsRef.current.length < 4) {
          if (Math.random() < 0.05) spawnTarget();
        }

        for (let i = targetsRef.current.length - 1; i >= 0; i--) {
          const target = targetsRef.current[i];
          if (target.userData.active) {
            target.position.add(target.userData.velocity.clone().multiplyScalar(dt));
            target.children[0].rotation.y += dt;
            target.children[1].rotation.x += dt * target.userData.rotSpeed;
            target.children[1].rotation.y += dt;

            if (target.position.z > 8) {
              scene.remove(target);
              targetsRef.current.splice(i, 1);
              generateSound('miss');
              
              // Project to screen for text
              const vector = target.position.clone();
              vector.project(cameraRef.current);
              const x = (vector.x * .5 + .5) * window.innerWidth;
              const y = (-(vector.y * .5) + .5) * window.innerHeight;
              addFloatingText(x, y, "MISS", "miss");
            }
          }
        }

        // Hand Interaction
        const landmarks = latestLandmarksRef.current;
        let aimPoint = new THREE.Vector3(0, 0, -20);
        let isShooting = false;

        if (landmarks) {
          const indexTip = landmarks[8];
          const indexMCP = landmarks[5];
          const thumbTip = landmarks[4];
          
          const ndcX = (1 - indexTip.x) * 2 - 1; 
          const ndcY = -(indexTip.y * 2 - 1);

          const raycaster = new THREE.Raycaster();
          raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), cameraRef.current);

          // Aim Assist
          let closestDist = Infinity;
          let closestTarget: THREE.Group | null = null;
          const magnetismThreshold = 3.0;
          const ray = raycaster.ray;

          targetsRef.current.forEach(target => {
            const targetCenter = target.position.clone();
            const dist = ray.distanceSqToPoint(targetCenter);
            if (dist < closestDist && dist < magnetismThreshold) {
              closestDist = dist;
              closestTarget = target;
            }
          });

          if (closestTarget) {
            aimPoint.copy(closestTarget.position);
            if (reticleRef.current) reticleRef.current.children.forEach((mesh: any) => mesh.material.color.setHex(0xff4655));
          } else {
            aimPoint.copy(ray.origin).add(ray.direction.multiplyScalar(20));
            if (reticleRef.current) reticleRef.current.children.forEach((mesh: any) => mesh.material.color.setHex(0x00ffff));
          }

          // Trigger
          const triggerDist = Math.hypot(thumbTip.x - indexMCP.x, thumbTip.y - indexMCP.y);
          if (triggerDist < 0.08) {
            if (!isTriggeredRef.current) {
               const now = Date.now();
               if (now - lastShotTimeRef.current > 250) {
                 isShooting = true;
                 lastShotTimeRef.current = now;
               }
               isTriggeredRef.current = true;
            }
          } else {
            isTriggeredRef.current = false;
          }

          // Visuals
          if (laserRef.current) {
            const positions = laserRef.current.geometry.attributes.position.array as Float32Array;
            const vec = new THREE.Vector3(ndcX, ndcY, 0.5);
            vec.unproject(cameraRef.current);
            vec.sub(cameraRef.current.position).normalize();
            const handWorldPos = cameraRef.current.position.clone().add(vec.multiplyScalar(8));

            positions[0] = handWorldPos.x + 0.2;
            positions[1] = handWorldPos.y - 0.5;
            positions[2] = handWorldPos.z;
            positions[3] = aimPoint.x;
            positions[4] = aimPoint.y;
            positions[5] = aimPoint.z;
            laserRef.current.geometry.attributes.position.needsUpdate = true;
          }

          if (reticleRef.current) {
            reticleRef.current.visible = true;
            reticleRef.current.position.copy(aimPoint);
            reticleRef.current.lookAt(cameraRef.current.position);
          }

          if (isShooting) {
            generateSound('shoot');
            if (closestTarget) {
              scene.remove(closestTarget);
              targetsRef.current = targetsRef.current.filter(t => t !== closestTarget);
              scoreRef.current += 1;
              onScoreUpdate(scoreRef.current);
              generateSound('hit');
              
              const vector = closestTarget.position.clone();
              vector.project(cameraRef.current);
              const x = (vector.x * .5 + .5) * window.innerWidth;
              const y = (-(vector.y * .5) + .5) * window.innerHeight;
              addFloatingText(x, y, "HIT", "hit");
            }
          }

        } else {
          // No Hand
          if (reticleRef.current) reticleRef.current.visible = false;
          if (laserRef.current) {
             const positions = laserRef.current.geometry.attributes.position.array as Float32Array;
             positions.fill(0);
             laserRef.current.geometry.attributes.position.needsUpdate = true;
          }
        }
      }

      renderer.render(scene, cameraRef.current);
      animationFrameId = requestAnimationFrame(loop);
    };

    // --- MediaPipe Init ---
    const initMP = async () => {
      try {
        if (!window.Hands) return;

        const hands = new window.Hands({
          locateFile: (file: string) => `https://unpkg.com/@mediapipe/hands@${MP_HANDS_VERSION}/${file}`
        });

        hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 1,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5
        });

        hands.onResults((results: any) => {
          // Store Data
          if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            latestLandmarksRef.current = results.multiHandLandmarks[0];
          } else {
            latestLandmarksRef.current = null;
          }

          // Draw Mini Canvas
          if (trackingCanvasRef.current) {
            const ctx = trackingCanvasRef.current.getContext('2d');
            if (ctx) {
              const w = trackingCanvasRef.current.width;
              const h = trackingCanvasRef.current.height;
              ctx.save();
              ctx.clearRect(0, 0, w, h);
              
              // Draw Feed
              if (results.image) {
                ctx.drawImage(results.image, 0, 0, w, h);
              }

              // Draw Grid Overlay (Scanline style)
              ctx.fillStyle = "rgba(0, 20, 10, 0.3)";
              ctx.fillRect(0, 0, w, h);

              // Draw Skeleton
              if (results.multiHandLandmarks) {
                for (const landmarks of results.multiHandLandmarks) {
                   window.drawConnectors(ctx, landmarks, window.HAND_CONNECTIONS, {color: '#00ffff', lineWidth: 2});
                   window.drawLandmarks(ctx, landmarks, {color: '#ff4655', lineWidth: 1, radius: 2});
                }
              }
              ctx.restore();
            }
          }
        });

        handsRef.current = hands;

        // Manual getUserMedia for better mobile control
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
           let stream;
           try {
             // Try Environment (Back) Camera First
             stream = await navigator.mediaDevices.getUserMedia({ 
               video: { facingMode: 'environment' },
               audio: false 
             });
           } catch (e) {
             console.warn("Environment camera failed, trying default...", e);
             try {
                // Try Default
                stream = await navigator.mediaDevices.getUserMedia({ 
                  video: true,
                  audio: false 
                });
             } catch (e2) {
                throw new Error("No camera accessible");
             }
           }

           if (videoRef.current) {
             videoRef.current.srcObject = stream;
             await videoRef.current.play();
             setCameraError(null);
           }
        } else {
           throw new Error("Browser API not supported");
        }

      } catch (err: any) {
        console.error("Camera Init Error:", err);
        setCameraError("OPTICAL SENSORS OFFLINE");
        
        // Render static on mini canvas if error
        if (trackingCanvasRef.current) {
          const ctx = trackingCanvasRef.current.getContext('2d');
          if (ctx) {
             ctx.fillStyle = "#000";
             ctx.fillRect(0,0,320,240);
             ctx.fillStyle = "red";
             ctx.font = "20px Arial";
             ctx.fillText("NO SIGNAL", 110, 120);
          }
        }
      }
    };

    initMP();
    animationFrameId = requestAnimationFrame(loop);

    const handleResize = () => {
        if(cameraRef.current && rendererRef.current) {
            const w = window.innerWidth;
            const h = window.innerHeight;
            cameraRef.current.aspect = w / h;
            cameraRef.current.updateProjectionMatrix();
            rendererRef.current.setSize(w, h);
        }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationFrameId);
      if (handsRef.current) handsRef.current.close();
      if (videoRef.current && videoRef.current.srcObject) {
         const stream = videoRef.current.srcObject as MediaStream;
         stream.getTracks().forEach(track => track.stop());
      }
      if (rendererRef.current) rendererRef.current.dispose();
    };
  }, [gameState, onScoreUpdate]); 

  return (
    <div ref={containerRef} className="absolute inset-0 w-full h-full bg-[#0f1923]">
      {/* Hidden Source Video */}
      <video 
        ref={videoRef} 
        className="hidden" 
        playsInline 
        muted 
        autoPlay
      ></video>
      
      {/* Main Game Canvas */}
      <canvas ref={canvasRef} className="block w-full h-full object-cover" />
      
      {/* Mini Tracking View (Bottom Right) */}
      <div className="absolute bottom-4 right-4 w-48 h-36 z-20 border-2 border-[#ff4655] bg-black overflow-hidden shadow-[0_0_15px_rgba(255,70,85,0.5)]">
         <canvas ref={trackingCanvasRef} width={320} height={240} className="w-full h-full object-cover opacity-80" />
         <div className="absolute top-0 left-0 bg-[#ff4655] text-white text-[10px] px-2 py-0.5 font-bold tracking-widest uppercase">
           {cameraReady ? 'Live Feed' : 'Searching...'}
         </div>
         {/* Decorative Scanlines */}
         <div className="absolute inset-0 pointer-events-none bg-[url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAYAAACZgbYnAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAABZJREFUeNpiYGBgAAJ0EA0AAwQYAAIAADs=')] opacity-30"></div>
      </div>

      {/* Camera Error Message */}
      {cameraError && (
        <div className="absolute top-24 left-1/2 -translate-x-1/2 w-[90%] md:w-auto bg-[#0f1923]/95 border-l-4 border-[#ff4655] text-white px-6 py-4 shadow-2xl z-30 flex flex-col items-center animate-pulse">
           <h3 className="text-[#ff4655] font-bold tracking-widest mb-1 text-xl">SYSTEM FAILURE</h3>
           <p className="text-gray-400 text-sm tracking-wide uppercase">{cameraError}</p>
        </div>
      )}

      {/* Floating Damage Text */}
      {floatingTexts.map(ft => (
        <div
          key={ft.id}
          className={`absolute text-5xl font-val font-bold pointer-events-none select-none ${
            ft.type === 'hit' ? 'text-[#00ffff] drop-shadow-[0_0_10px_#00ffff]' : 'text-[#ff4655] drop-shadow-[0_0_5px_#ff0000]'
          }`}
          style={{ 
            left: ft.x, 
            top: ft.y, 
            animation: 'floatUp 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards'
          }}
        >
          {ft.text}
        </div>
      ))}
      
      <style>{`
        @keyframes floatUp {
          0% { opacity: 0; transform: translate(-50%, -50%) scale(0.5); }
          50% { opacity: 1; transform: translate(-50%, -120%) scale(1.2); }
          100% { opacity: 0; transform: translate(-50%, -150%) scale(1); }
        }
      `}</style>
    </div>
  );
}