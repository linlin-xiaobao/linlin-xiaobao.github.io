import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { generateSound } from '../utils/sound';

// Declare global types for the loaded scripts
declare global {
  interface Window {
    Hands: any;
    Camera: any;
    drawConnectors: any;
    drawLandmarks: any;
    HAND_CONNECTIONS: any;
  }
}

interface ARGameProps {
  gameState: number; // 0: Menu, 1: Playing, 2: GameOver
  onScoreUpdate: (score: number) => void;
  onGameOver: (score: number) => void;
}

const MP_HANDS_VERSION = '0.4.1646424915';

export default function ARGame({ gameState, onScoreUpdate, onGameOver }: ARGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(document.createElement('video'));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // Game Logic Refs
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const targetsRef = useRef<THREE.Mesh[]>([]);
  const laserRef = useRef<THREE.Line | null>(null);
  const reticleRef = useRef<THREE.Mesh | null>(null);
  const scoreRef = useRef(0);
  const isTriggeredRef = useRef(false);
  const lastShotTimeRef = useRef(0);
  
  // Floating Texts
  const [floatingTexts, setFloatingTexts] = useState<{id: number, x: number, y: number, text: string, type: 'hit' | 'miss'}[]>([]);

  useEffect(() => {
    if (!containerRef.current || !canvasRef.current) return;

    let hands: any;
    let camera: any;
    let animationFrameId: number;
    let clock = new THREE.Clock();

    // --- Three.js Setup ---
    const width = window.innerWidth;
    const height = window.innerHeight;

    const scene = new THREE.Scene();
    // Ambient light
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);
    // Directional Light
    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(0, 10, 5);
    scene.add(dirLight);

    const aspect = width / height;
    const fov = 60;
    const threeCamera = new THREE.PerspectiveCamera(fov, aspect, 0.1, 1000);
    threeCamera.position.z = 10; 

    const renderer = new THREE.WebGLRenderer({ 
      canvas: canvasRef.current, 
      alpha: true,
      antialias: true 
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    sceneRef.current = scene;
    cameraRef.current = threeCamera;
    rendererRef.current = renderer;

    // --- Game Objects ---
    // Laser Line
    const laserMaterial = new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2, transparent: true, opacity: 0.6 });
    const laserGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,-100)]);
    const laserLine = new THREE.Line(laserGeometry, laserMaterial);
    laserLine.frustumCulled = false;
    scene.add(laserLine);
    laserRef.current = laserLine;

    // Reticle
    const reticleGeo = new THREE.RingGeometry(0.15, 0.2, 32);
    const reticleMat = new THREE.MeshBasicMaterial({ color: 0x00ff00, side: THREE.DoubleSide, transparent: true, opacity: 0.8 });
    const reticle = new THREE.Mesh(reticleGeo, reticleMat);
    scene.add(reticle);
    reticleRef.current = reticle;

    // Video Background Texture
    const videoTexture = new THREE.VideoTexture(videoRef.current);
    videoTexture.colorSpace = THREE.SRGBColorSpace;
    scene.background = videoTexture;

    // --- Helpers ---
    const addFloatingText = (x: number, y: number, text: string, type: 'hit' | 'miss') => {
      const id = Date.now() + Math.random();
      setFloatingTexts(prev => [...prev, { id, x, y, text, type }]);
      setTimeout(() => {
        setFloatingTexts(prev => prev.filter(ft => ft.id !== id));
      }, 800);
    };

    const spawnTarget = () => {
      const geometry = new THREE.CylinderGeometry(0.5, 0.5, 0.1, 32);
      geometry.rotateX(Math.PI / 2); // Face camera
      const material = new THREE.MeshPhongMaterial({ 
        color: 0x00ffff, 
        emissive: 0x004444,
        shininess: 100
      });
      const target = new THREE.Mesh(geometry, material);
      
      // Spawn at edges
      const spawnDist = 15;
      const angle = Math.random() * Math.PI * 2;
      target.position.set(
        Math.cos(angle) * spawnDist,
        Math.sin(angle) * spawnDist * 0.6, // Elliptical distribution
        -15 // Depth
      );
      
      // Look at center
      target.lookAt(0, 0, -5);
      
      // Store user data
      target.userData = {
        velocity: new THREE.Vector3().subVectors(new THREE.Vector3(0,0,-5), target.position).normalize().multiplyScalar(2 + Math.random() * 2),
        active: true
      };
      
      scene.add(target);
      targetsRef.current.push(target);
    };

    // --- MediaPipe Logic ---
    const onResults = (results: any) => {
      if (!sceneRef.current || !cameraRef.current || !rendererRef.current) return;
      if (gameState !== 1) {
        // If not playing, just render scene
        rendererRef.current.render(sceneRef.current, cameraRef.current);
        return;
      }

      const dt = clock.getDelta();

      // 1. Maintain Target Count
      while (targetsRef.current.length < 4) {
        spawnTarget();
      }

      // 2. Update Targets
      for (let i = targetsRef.current.length - 1; i >= 0; i--) {
        const target = targetsRef.current[i];
        if (target.userData.active) {
          target.position.add(target.userData.velocity.clone().multiplyScalar(dt));
          target.rotation.z += 2 * dt;

          // Check if passed camera
          if (target.position.z > 5) {
            sceneRef.current.remove(target);
            targetsRef.current.splice(i, 1);
            generateSound('miss');
            // Project 3D pos to 2D for "MISS" text
            const vector = target.position.clone();
            vector.project(cameraRef.current);
            const x = (vector.x * .5 + .5) * window.innerWidth;
            const y = (-(vector.y * .5) + .5) * window.innerHeight;
            addFloatingText(x, y, "MISS", "miss");
            // Penalty? Maybe not for now, just replace.
          }
        }
      }

      // 3. Process Hand
      let aimPoint = new THREE.Vector3(0, 0, -20); // Default aim center
      let isShooting = false;
      let handFound = false;

      if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        handFound = true;
        const landmarks = results.multiHandLandmarks[0];
        
        // Landmarks: 0=Wrist, 5=IndexMCP, 8=IndexTip, 4=ThumbTip
        // Use normalized coordinates (0-1)
        const indexTip = landmarks[8];
        const indexMCP = landmarks[5];
        const thumbTip = landmarks[4];
        
        // Convert Index Tip to Screen Coordinates for Raycasting
        // MediaPipe x is inverted (1 is left, 0 is right) for selfie mode usually, but depends on camera.
        // Assuming default selfie:
        const ndcX = (1 - indexTip.x) * 2 - 1; 
        const ndcY = -(indexTip.y * 2 - 1);

        // Raycast from Camera
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), cameraRef.current);
        
        // --- Magnetic Aim Assist ---
        let closestDist = Infinity;
        let closestTarget: THREE.Mesh | null = null;
        const magnetismThreshold = 2.5; // World units radius

        // Project ray to finding targets close to the beam
        const ray = raycaster.ray;
        
        targetsRef.current.forEach(target => {
          // Distance from point to line
          const targetCenter = target.position.clone();
          const dist = ray.distanceSqToPoint(targetCenter);
          
          if (dist < closestDist && dist < magnetismThreshold) {
            closestDist = dist;
            closestTarget = target;
          }
        });

        if (closestTarget) {
          // Snap aim to target center
          aimPoint.copy(closestTarget.position);
          if (reticleRef.current) (reticleRef.current.material as THREE.MeshBasicMaterial).color.setHex(0xff0000); // Red when locked
        } else {
          // Default ray direction deep into screen
          aimPoint.copy(ray.origin).add(ray.direction.multiplyScalar(20));
          if (reticleRef.current) (reticleRef.current.material as THREE.MeshBasicMaterial).color.setHex(0x00ff00); // Green normally
        }

        // --- Gesture Detection (Pistol) ---
        // Distance between thumb tip and index MCP (Trigger action)
        const triggerDist = Math.hypot(thumbTip.x - indexMCP.x, thumbTip.y - indexMCP.y);
        const triggerThreshold = 0.06; // Tunable based on hand size in frame

        if (triggerDist < triggerThreshold) {
          if (!isTriggeredRef.current) {
            // Trigger Pull Event
            const now = Date.now();
            if (now - lastShotTimeRef.current > 200) { // Fire rate cap
              isShooting = true;
              lastShotTimeRef.current = now;
            }
            isTriggeredRef.current = true;
          }
        } else {
          isTriggeredRef.current = false;
        }

        // Update Laser Visuals
        if (laserRef.current) {
          const positions = laserRef.current.geometry.attributes.position.array as Float32Array;
          // Start at hand position (approximately) relative to camera plane
          // We project the hand 2D pos to a 3D pos near camera z
          const handZ = -2;
          const vec = new THREE.Vector3(ndcX, ndcY, 0.5);
          vec.unproject(cameraRef.current);
          vec.sub(cameraRef.current.position).normalize();
          const distance = (handZ - cameraRef.current.position.z) / vec.z;
          const handWorldPos = cameraRef.current.position.clone().add(vec.multiplyScalar(distance));

          positions[0] = handWorldPos.x;
          positions[1] = handWorldPos.y - 0.5; // Lower slightly to look like holding gun
          positions[2] = handWorldPos.z;
          
          positions[3] = aimPoint.x;
          positions[4] = aimPoint.y;
          positions[5] = aimPoint.z;
          
          laserRef.current.geometry.attributes.position.needsUpdate = true;
        }

        // Update Reticle
        if (reticleRef.current) {
          reticleRef.current.position.copy(aimPoint);
          // Scale based on distance to keep constant size visually
          const dist = cameraRef.current.position.distanceTo(aimPoint);
          const scale = dist * 0.05;
          reticleRef.current.scale.set(scale, scale, scale);
          reticleRef.current.lookAt(cameraRef.current.position);
        }

        // --- Shooting Logic ---
        if (isShooting) {
          generateSound('shoot');
          
          // Recoil visual (shake camera slightly or move laser up)
          // Simplified: check hit
          if (closestTarget) {
            // Destroy target
            sceneRef.current.remove(closestTarget);
            targetsRef.current = targetsRef.current.filter(t => t !== closestTarget);
            
            // Score
            scoreRef.current += 1;
            onScoreUpdate(scoreRef.current);
            generateSound('hit');

            // Visual FX
            const vector = closestTarget.position.clone();
            vector.project(cameraRef.current);
            const x = (vector.x * .5 + .5) * window.innerWidth;
            const y = (-(vector.y * .5) + .5) * window.innerHeight;
            addFloatingText(x, y, "HIT!", "hit");
          }
        }
      } else {
        // Hide reticle if no hand
        if (reticleRef.current) reticleRef.current.scale.set(0,0,0);
        if (laserRef.current) {
             const positions = laserRef.current.geometry.attributes.position.array as Float32Array;
             positions.fill(0);
             laserRef.current.geometry.attributes.position.needsUpdate = true;
        }
      }

      rendererRef.current.render(sceneRef.current, cameraRef.current);
    };

    // --- Initialization ---
    const initMP = async () => {
      if (!window.Hands) {
         console.error("MediaPipe Hands not loaded");
         return;
      }

      hands = new window.Hands({
        locateFile: (file: string) => {
          // Force specific version for WASM as requested
          return `https://unpkg.com/@mediapipe/hands@${MP_HANDS_VERSION}/${file}`;
        }
      });

      hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
      });

      hands.onResults(onResults);

      // Camera Setup
      if (typeof window.Camera !== 'undefined') {
        camera = new window.Camera(videoRef.current, {
          onFrame: async () => {
            await hands.send({image: videoRef.current});
          },
          width: 1280,
          height: 720
        });
        camera.start();
      } else {
        console.error("MediaPipe Camera Utils not loaded");
      }
    };

    // Start everything
    initMP();

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
      if (camera) camera.stop();
      if (hands) hands.close();
      if (rendererRef.current && containerRef.current) {
        // Cleanup ThreeJS
        // containerRef.current.removeChild(rendererRef.current.domElement);
      }
      // Reset score on unmount if needed, but we handle that in parent
    };
  }, [gameState]); // Re-run if game state changes significantly, or just init once. Ideally init once.

  return (
    <div ref={containerRef} className="absolute inset-0 w-full h-full bg-black">
      {/* Hidden Video Source */}
      <video ref={videoRef} className="hidden" playsInline muted></video>
      {/* Canvas Output */}
      <canvas ref={canvasRef} className="block w-full h-full object-cover" />
      
      {/* Floating Damage Text Layer */}
      {floatingTexts.map(ft => (
        <div
          key={ft.id}
          className={`absolute text-4xl font-bold pointer-events-none select-none animate-float-up ${
            ft.type === 'hit' ? 'text-[#00ff00] drop-shadow-[0_0_5px_#00ff00]' : 'text-red-500'
          }`}
          style={{ 
            left: ft.x, 
            top: ft.y, 
            transform: 'translate(-50%, -50%)',
            animation: 'floatUp 0.8s ease-out forwards'
          }}
        >
          {ft.text}
        </div>
      ))}
      
      <style>{`
        @keyframes floatUp {
          0% { opacity: 1; transform: translate(-50%, -50%) scale(0.8); }
          50% { transform: translate(-50%, -100%) scale(1.2); }
          100% { opacity: 0; transform: translate(-50%, -150%) scale(1); }
        }
        .animate-float-up {
          animation-name: floatUp;
          animation-duration: 0.8s;
          animation-fill-mode: forwards;
        }
      `}</style>
    </div>
  );
}