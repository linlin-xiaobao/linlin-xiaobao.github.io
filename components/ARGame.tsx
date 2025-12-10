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
  const muzzleFlashRef = useRef<THREE.Mesh | null>(null);
  const droneTextureRef = useRef<THREE.Texture | null>(null);
  
  const scoreRef = useRef(0);
  const isTriggeredRef = useRef(false);
  const lastShotTimeRef = useRef(0);
  const latestLandmarksRef = useRef<any>(null);
  const handsRef = useRef<any>(null);
  const processingRef = useRef(false);
  
  // State
  const [initialized, setInitialized] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [floatingTexts, setFloatingTexts] = useState<{id: number, x: number, y: number, text: string, type: 'hit' | 'miss'}[]>([]);

  // Recoil State
  const recoilRef = useRef({ x: 0, y: 0, decay: 0.85 });

  const log = (msg: string) => {
    console.log(msg);
    setLogs(prev => [msg, ...prev].slice(0, 5));
  };

  const addFloatingText = (x: number, y: number, text: string, type: 'hit' | 'miss') => {
    const id = Date.now() + Math.random();
    setFloatingTexts(prev => [...prev, { id, x, y, text, type }]);
    setTimeout(() => {
      setFloatingTexts(prev => prev.filter(ft => ft.id !== id));
    }, 800);
  };

  const triggerHaptic = (pattern: number | number[]) => {
    if (navigator.vibrate) {
      navigator.vibrate(pattern);
    }
  };

  // Create procedural drone texture
  const createDroneTexture = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (ctx) {
        // Glow
        const grad = ctx.createRadialGradient(128,128,40, 128,128,120);
        grad.addColorStop(0, 'rgba(0, 255, 255, 1)');
        grad.addColorStop(0.5, 'rgba(0, 100, 100, 0.5)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0,0,256,256);
        
        // Inner Core
        ctx.beginPath();
        ctx.arc(128, 128, 40, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        
        // Tech rings
        ctx.strokeStyle = '#ff4655';
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.arc(128, 128, 60, 0, Math.PI * 1.5);
        ctx.stroke();

        ctx.strokeStyle = '#00ffff';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(128, 128, 75, Math.PI, Math.PI * 2.5);
        ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(canvas);
    droneTextureRef.current = tex;
    return tex;
  };

  // --- Initialization Sequence (Triggered by user click) ---
  const startSystem = async () => {
    if (initialized) return;
    setInitialized(true);
    log("System Initializing...");

    // Resume Audio Context
    try {
       generateSound('ui');
    } catch(e) {
       log("Audio init warning");
    }

    // 1. Initialize MediaPipe
    try {
        if (!window.Hands) {
            log("Waiting for MediaPipe...");
            await new Promise(r => setTimeout(r, 1000)); // Give script a moment
            if (!window.Hands) throw new Error("MediaPipe script failed to load");
        }
        
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
           if (results.multiHandLandmarks?.length) {
               latestLandmarksRef.current = results.multiHandLandmarks[0];
           } else {
               latestLandmarksRef.current = null;
           }

           // Draw Tracking View
           if (trackingCanvasRef.current && results.image && window.drawConnectors) {
              const ctx = trackingCanvasRef.current.getContext('2d');
              if (ctx) {
                  const w = trackingCanvasRef.current.width;
                  const h = trackingCanvasRef.current.height;
                  ctx.save();
                  ctx.clearRect(0,0,w,h);
                  ctx.scale(-1, 1);
                  ctx.translate(-w, 0);
                  ctx.drawImage(results.image, 0, 0, w, h);
                  ctx.restore();
                  
                  // Stylized Overlay
                  ctx.fillStyle = "rgba(0, 255, 255, 0.1)";
                  ctx.fillRect(0,0,w,h);
                  
                  if (results.multiHandLandmarks) {
                      for (const l of results.multiHandLandmarks) {
                          ctx.save();
                          ctx.scale(-1, 1);
                          ctx.translate(-w, 0);
                          window.drawConnectors(ctx, l, window.HAND_CONNECTIONS, {color: '#00ffff', lineWidth: 2});
                          ctx.restore();
                      }
                  }
              }
           }
        });
        handsRef.current = hands;
        log("AI Core Online");
    } catch (e: any) {
        log("AI ERROR: " + e.message);
        setCameraError("AI CORE FAILED");
    }

    // 2. Initialize Camera
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
       let stream;
       log("Requesting Optical Sensors...");
       try {
          // Explicitly ask for 480p/VGA to ensure mobile support and performance
          stream = await navigator.mediaDevices.getUserMedia({ 
              video: { 
                  facingMode: 'user', 
                  width: { ideal: 640 }, 
                  height: { ideal: 480 },
                  frameRate: { ideal: 30 }
              }, 
              audio: false 
          });
          log("Front Sensor Acquired");
       } catch (e: any) {
          log("Front Sensor Fail: " + e.message);
          try {
              stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
              log("Rear Sensor Acquired");
          } catch (e2) {
              try {
                  stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                  log("Generic Sensor Acquired");
              } catch(e3: any) {
                  log("FATAL: No Sensors");
                  setCameraError("NO CAMERA FOUND");
                  return;
              }
          }
       }
       
       if (videoRef.current && stream) {
           videoRef.current.srcObject = stream;
           videoRef.current.onloadedmetadata = () => {
               log("Video Metadata Loaded");
               videoRef.current?.play()
                .then(() => log("Video Feed Active"))
                .catch(e => {
                    log("Play Blocked: " + e.message);
                    setCameraError("CAMERA PERMISSION BLOCKED");
                });
           };
       }
    } else {
        log("MediaDevices API missing");
        setCameraError("BROWSER UNSUPPORTED");
    }
  };

  useEffect(() => {
    if (!containerRef.current || !canvasRef.current) return;

    let animationFrameId: number;
    let clock = new THREE.Clock();

    // --- Three.js Setup ---
    const width = containerRef.current.clientWidth || window.innerWidth;
    const height = containerRef.current.clientHeight || window.innerHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1923); // Default Valorant Blue

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xff4655, 3);
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
    
    // Initialize Texture
    createDroneTexture();

    // Environment Grid (Always visible fallback)
    const gridHelper = new THREE.GridHelper(200, 50, 0x00ffff, 0x1a2b3c);
    gridHelper.position.y = -20;
    (gridHelper.material as THREE.Material).transparent = true;
    (gridHelper.material as THREE.Material).opacity = 0.15;
    scene.add(gridHelper);
    
    // Particles
    const particlesGeo = new THREE.BufferGeometry();
    const particleCount = 200;
    const posArray = new Float32Array(particleCount * 3);
    for(let i=0; i<particleCount*3; i++) {
        posArray[i] = (Math.random() - 0.5) * 100;
    }
    particlesGeo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    const particlesMat = new THREE.PointsMaterial({
        size: 0.2,
        color: 0x00ffff,
        transparent: true,
        opacity: 0.4
    });
    const particles = new THREE.Points(particlesGeo, particlesMat);
    scene.add(particles);

    // Laser Line
    const laserMaterial = new THREE.LineBasicMaterial({ 
      color: 0xff4655, // Valorant Red
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

    // Muzzle Flash
    const flashGeo = new THREE.PlaneGeometry(3, 3);
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (ctx) {
        const grad = ctx.createRadialGradient(32,32,0, 32,32,32);
        grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
        grad.addColorStop(0.3, 'rgba(255, 200, 100, 0.8)');
        grad.addColorStop(1, 'rgba(255, 70, 85, 0)'); 
        ctx.fillStyle = grad;
        ctx.fillRect(0,0,64,64);
    }
    const flashTex = new THREE.CanvasTexture(canvas);
    const flashMat = new THREE.MeshBasicMaterial({ 
        map: flashTex, 
        transparent: true, 
        opacity: 0, 
        depthTest: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
    });
    const muzzleFlash = new THREE.Mesh(flashGeo, flashMat);
    muzzleFlash.visible = false;
    scene.add(muzzleFlash);
    muzzleFlashRef.current = muzzleFlash;

    // Reticle
    const reticleGroup = new THREE.Group();
    const dotGeo = new THREE.CircleGeometry(0.08, 16);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0x00ffff });
    reticleGroup.add(new THREE.Mesh(dotGeo, dotMat));
    
    const ringGeo = new THREE.RingGeometry(0.4, 0.45, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    reticleGroup.add(ring);
    
    scene.add(reticleGroup);
    reticleRef.current = reticleGroup;

    // Video Texture Placeholder
    let videoTexture: THREE.VideoTexture | null = null;

    // --- Spawner ---
    const spawnTarget = () => {
      const group = new THREE.Group();
      if (droneTextureRef.current) {
          const spriteMat = new THREE.SpriteMaterial({ 
              map: droneTextureRef.current,
              color: 0xffffff,
              blending: THREE.AdditiveBlending
          });
          const sprite = new THREE.Sprite(spriteMat);
          sprite.scale.set(3, 3, 1);
          group.add(sprite);
      }
      
      const ringGeo = new THREE.TorusGeometry(1.2, 0.05, 8, 32);
      const ringMat = new THREE.MeshBasicMaterial({ color: 0xff4655, wireframe: true });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      group.add(ring);

      const spawnDist = 25;
      const angle = (Math.random() - 0.5) * Math.PI * 1.5; 
      group.position.set(
        Math.sin(angle) * spawnDist,
        (Math.random() - 0.5) * 12, 
        -30 + (Math.random() * 5)
      );
      
      group.userData = {
        velocity: new THREE.Vector3(0,0,1).applyEuler(new THREE.Euler(0, -angle, 0)).multiplyScalar(5 + Math.random() * 4), 
        active: true,
        rotSpeed: (Math.random() - 0.5) * 5
      };
      
      scene.add(group);
      targetsRef.current.push(group);
    };

    // --- Game Loop ---
    const loop = () => {
      if (!sceneRef.current || !cameraRef.current || !rendererRef.current) return;
      
      const dt = clock.getDelta();
      const elapsed = clock.getElapsedTime();

      // 1. Video Update
      if (videoRef.current && videoRef.current.readyState >= 2) {
         // Create texture once we have dimensions
         if (!videoTexture) {
             videoTexture = new THREE.VideoTexture(videoRef.current);
             videoTexture.colorSpace = THREE.SRGBColorSpace;
             videoTexture.minFilter = THREE.LinearFilter;
         }
         
         if (videoTexture && !cameraReady) {
           scene.background = videoTexture;
           setCameraReady(true);
         }
        
        if (handsRef.current && !processingRef.current && elapsed % 0.1 < 0.05) { 
          processingRef.current = true;
          handsRef.current.send({image: videoRef.current})
            .then(() => { processingRef.current = false; })
            .catch(() => { processingRef.current = false; });
        }
      }

      // Recoil
      recoilRef.current.x *= recoilRef.current.decay;
      recoilRef.current.y *= recoilRef.current.decay;
      cameraRef.current.rotation.x = recoilRef.current.y * 0.1;
      cameraRef.current.rotation.y = recoilRef.current.x * 0.1;

      // 2. Logic
      if (gameState === 1) { // Playing
        if (targetsRef.current.length < 4 && Math.random() < 0.05) {
           spawnTarget();
        }

        for (let i = targetsRef.current.length - 1; i >= 0; i--) {
          const target = targetsRef.current[i];
          if (target.userData.active) {
            target.position.add(target.userData.velocity.clone().multiplyScalar(dt));
            
            if(target.children[1]) {
                target.children[1].rotation.x += dt * 2;
                target.children[1].rotation.y += dt * target.userData.rotSpeed;
            }

            const scale = 1 + Math.sin(elapsed * 5) * 0.1;
            target.scale.setScalar(scale);

            if (target.position.z > 5) {
              scene.remove(target);
              targetsRef.current.splice(i, 1);
              generateSound('miss');
              
              const vector = target.position.clone();
              vector.project(cameraRef.current);
              const x = (vector.x * .5 + .5) * containerRef.current!.clientWidth;
              const y = (-(vector.y * .5) + .5) * containerRef.current!.clientHeight;
              addFloatingText(x, y, "MISS", "miss");
            }
          }
        }

        const landmarks = latestLandmarksRef.current;
        let isShooting = false;
        
        if (landmarks) {
          const indexTip = landmarks[8];
          const indexMCP = landmarks[5];
          const thumbTip = landmarks[4];
          
          const ndcX = -(1 - indexTip.x) * 2 + 1;
          const ndcY = -(indexTip.y * 2 - 1);
          
          const raycaster = new THREE.Raycaster();
          raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), cameraRef.current);
          
          const vec = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(cameraRef.current);
          vec.sub(cameraRef.current.position).normalize();
          const handPos = cameraRef.current.position.clone().add(vec.multiplyScalar(3));

          let aimPoint = raycaster.ray.origin.clone().add(raycaster.ray.direction.multiplyScalar(50));
          let closestTarget: THREE.Group | null = null;
          let minDist = 3.0; 

          targetsRef.current.forEach(target => {
            const dist = raycaster.ray.distanceSqToPoint(target.position);
            if (dist < minDist) {
              minDist = dist;
              closestTarget = target;
            }
          });

          if (closestTarget) {
            aimPoint.copy((closestTarget as THREE.Group).position);
            if (reticleRef.current) {
                (reticleRef.current.children[0] as THREE.Mesh).material = new THREE.MeshBasicMaterial({ color: 0xff0000 });
            }
          } else {
             if (reticleRef.current) {
                (reticleRef.current.children[0] as THREE.Mesh).material = new THREE.MeshBasicMaterial({ color: 0x00ffff });
             }
          }

          const triggerDist = Math.hypot(thumbTip.x - indexMCP.x, thumbTip.y - indexMCP.y);
          if (triggerDist < 0.12) {
            if (!isTriggeredRef.current) {
               const now = Date.now();
               if (now - lastShotTimeRef.current > 120) {
                 isShooting = true;
                 lastShotTimeRef.current = now;
               }
               isTriggeredRef.current = true;
            }
          } else {
            isTriggeredRef.current = false;
          }

          if (reticleRef.current) {
              reticleRef.current.visible = true;
              reticleRef.current.position.copy(aimPoint);
              reticleRef.current.lookAt(cameraRef.current.position);
              const d = cameraRef.current.position.distanceTo(aimPoint);
              const s = d * 0.03;
              reticleRef.current.scale.set(s,s,s);
          }
          if (laserRef.current) {
              const pos = laserRef.current.geometry.attributes.position.array as Float32Array;
              pos[0] = handPos.x; pos[1] = handPos.y - 0.2; pos[2] = handPos.z;
              pos[3] = aimPoint.x; pos[4] = aimPoint.y; pos[5] = aimPoint.z;
              laserRef.current.geometry.attributes.position.needsUpdate = true;
          }

          if (isShooting) {
            generateSound('shoot');
            triggerHaptic(30);
            
            recoilRef.current.x = (Math.random() - 0.5) * 0.4;
            recoilRef.current.y = 0.6; 

            if (muzzleFlashRef.current) {
                muzzleFlashRef.current.position.copy(handPos).add(new THREE.Vector3(0,0,-1.5));
                muzzleFlashRef.current.lookAt(aimPoint);
                muzzleFlashRef.current.visible = true;
                setTimeout(() => { if(muzzleFlashRef.current) muzzleFlashRef.current.visible = false; }, 60);
            }

            if (closestTarget) {
               scene.remove(closestTarget);
               targetsRef.current = targetsRef.current.filter(t => t !== closestTarget);
               scoreRef.current += 1;
               onScoreUpdate(scoreRef.current);
               generateSound('hit');
               triggerHaptic([30, 50]);
               
               const vector = closestTarget.position.clone();
               vector.project(cameraRef.current);
               const x = (vector.x * .5 + .5) * containerRef.current!.clientWidth;
               const y = (-(vector.y * .5) + .5) * containerRef.current!.clientHeight;
               addFloatingText(x, y, "DESTROYED", "hit");
            }
          }
        } else {
           if (reticleRef.current) reticleRef.current.visible = false;
           if (laserRef.current) {
              (laserRef.current.geometry.attributes.position.array as Float32Array).fill(0);
              laserRef.current.geometry.attributes.position.needsUpdate = true;
           }
        }
      }

      renderer.render(scene, cameraRef.current);
      animationFrameId = requestAnimationFrame(loop);
    };

    // Start rendering immediately
    animationFrameId = requestAnimationFrame(loop);

    // Resize Handler
    const handleResize = () => {
        if (!containerRef.current || !cameraRef.current || !rendererRef.current) return;
        const w = containerRef.current.clientWidth || window.innerWidth;
        const h = containerRef.current.clientHeight || window.innerHeight;
        cameraRef.current.aspect = w / h;
        cameraRef.current.updateProjectionMatrix();
        rendererRef.current.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);
    handleResize();

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationFrameId);
      if(handsRef.current) handsRef.current.close();
      if(sceneRef.current) sceneRef.current.clear();
      if(rendererRef.current) rendererRef.current.dispose();
      const s = videoRef.current?.srcObject as MediaStream;
      s?.getTracks().forEach(t => t.stop());
    };
  }, [gameState, onScoreUpdate]);

  return (
    <div ref={containerRef} className="absolute inset-0 w-full h-full bg-[#0f1923] overflow-hidden">
      {/* Decorative Overlays */}
      <div className="absolute inset-0 pointer-events-none z-10 opacity-60" 
           style={{ background: 'radial-gradient(circle at center, transparent 30%, #000 120%)' }}></div>
      
      {/* HUD Lines */}
      <div className="absolute top-20 left-10 w-64 h-px bg-white/20 z-10 hidden md:block"></div>
      <div className="absolute bottom-20 right-10 w-64 h-px bg-white/20 z-10 hidden md:block"></div>
      
      <video ref={videoRef} className="hidden" playsInline muted></video>
      <canvas ref={canvasRef} className="block w-full h-full" />
      
      {/* Init Overlay - Required for Mobile Autoplay */}
      {!initialized && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm cursor-pointer"
             onClick={startSystem}>
            <div className="border-2 border-[#ff4655] p-10 text-center animate-pulse">
                <h1 className="text-4xl text-[#ff4655] font-val font-bold mb-4">SYSTEM OFFLINE</h1>
                <p className="text-white text-xl font-val tracking-widest">TAP TO INITIALIZE</p>
            </div>
        </div>
      )}

      {/* Mini Tracking */}
      {initialized && (
        <div className="absolute bottom-4 right-4 w-40 h-32 md:w-56 md:h-40 z-20 border border-[#ff4655] bg-black/80 shadow-[0_0_10px_#ff4655]">
           <canvas ref={trackingCanvasRef} width={320} height={240} className="w-full h-full object-cover tracking-scanline opacity-80" />
           <div className="absolute bottom-0 w-full bg-[#ff4655] text-black text-[10px] font-bold px-1 font-val flex justify-between">
              <span>TARGETING SYS: {cameraReady ? 'ONLINE' : 'SEARCHING...'}</span>
              <span>FPS: 60</span>
           </div>
        </div>
      )}

      {/* On Screen Log / Error */}
      <div className="absolute top-2 left-2 z-40 font-mono text-[10px] text-green-400 pointer-events-none opacity-70">
        {logs.map((l, i) => <div key={i}>{l}</div>)}
        {cameraError && <div className="text-red-500 font-bold bg-black/50 p-1">{cameraError}</div>}
      </div>

      {floatingTexts.map(ft => (
        <div key={ft.id} className="absolute font-val font-bold text-6xl pointer-events-none"
             style={{ 
               left: ft.x, top: ft.y, 
               color: ft.type === 'hit' ? '#ff4655' : '#fff',
               textShadow: ft.type === 'hit' ? '0 0 20px #ff4655' : '0 0 10px #fff',
               animation: 'floatUp 0.6s ease-out forwards'
             }}>
           {ft.text}
        </div>
      ))}
      <style>{`@keyframes floatUp { 0% { opacity: 0; transform: translate(-50%, 0) scale(0.5); } 20% { opacity: 1; transform: translate(-50%, -20px) scale(1.2); } 100% { opacity: 0; transform: translate(-50%, -80px) scale(1); } }`}</style>
    </div>
  );
}