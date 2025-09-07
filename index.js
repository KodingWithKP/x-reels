// index.js - X-Reels Server (v34 - Robust FFmpeg Input Handling)
// This file contains the core logic for the application.

// --- 1. Imports and Setup ---
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const ElevenLabs = require('elevenlabs-node');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));

// --- 2. API Client Initialization ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const elevenlabs = new ElevenLabs({
    apiKey: process.env.ELEVENLABS_API_KEY,
});

const FFMPEG_PATH = require('ffmpeg-static');
ffmpeg.setFfmpegPath(FFMPEG_PATH);


// --- 3. Directory and Config Setup ---
const outputDir = path.join(__dirname, 'outputs');
const assetsDir = path.join(__dirname, 'assets');
const templatesDir = path.join(__dirname, 'templates');
const musicDir = path.join(__dirname, 'assets', 'music');
[outputDir, assetsDir, templatesDir, musicDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

const SHOW_CREDITS_IMAGE = process.env.SHOW_CREDITS_IMAGE === 'true';
const creditsImagePath = path.join(assetsDir, 'credits.png');


// --- 4. Helper Functions ---
function handleGoogleAIError(error, res) {
    console.error("Google AI Error:", error);
    if (error.status === 429) {
        let retryMessage = "You've exceeded the API request limit. Please wait a moment and try again.";
        const retryInfo = error.errorDetails?.find(d => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
        if (retryInfo && retryInfo.retryDelay) {
            retryMessage = `API rate limit exceeded. Please wait for ${retryInfo.retryDelay} before trying again.`;
        }
        return res.status(429).json({ error: retryMessage });
    }
    res.status(500).json({ error: `An error occurred with the AI model: ${error.message}` });
}

function addPillarboxInstruction(prompt) {
    return `${prompt}. CRITICAL INSTRUCTION: The final image must be a VERTICAL 9:16 composition that fills the FULL HEIGHT of the square output frame. Add black bars ONLY to the left and right (pillarboxing) to fill the width.`;
}

// --- 5. Core AI & Video Functions ---

async function generateScript(inputText, template) {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = `
        ${template.system_prompt}
        Input Text: "${inputText}"
        ${template.format_instructions}
        Example of the JSON structure you should provide:
        ${JSON.stringify({ scenes: template.example_output.scenes }, null, 2)}
    `;
    const result = await model.generateContent(prompt);
    return JSON.parse((await result.response).text().replace(/```json|```/g, '').trim());
}

async function splitTextToScript(inputText) {
    let sentences = inputText.match(/[^.!?]+[.!?]+/g) || [inputText];
    if (sentences.length > 10) sentences = sentences.slice(0, 10);

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const formattedSentences = sentences.map((s, i) => `${i + 1}. ${s.trim()}`).join('\n');

    const prompt = `
        You are a creative director. For each numbered sentence provided below, create a single, highly detailed, and cinematic visual prompt for an AI image generator.
        CRITICAL INSTRUCTION: Each visual must be a VERTICAL 9:16 composition that fills the FULL HEIGHT of the square output frame. Add black bars ONLY to the left and right (pillarboxing) to fill the width.
        Return your response as a valid JSON object with a single key "visuals", which is an array of strings. The array must have exactly ${sentences.length} items.
        Input Sentences:\n${formattedSentences}
    `;
    
    const result = await model.generateContent(prompt);
    const jsonResponse = JSON.parse((await result.response).text().replace(/```json|```/g, '').trim());
    const visualPrompts = jsonResponse.visuals;

    if (!visualPrompts || visualPrompts.length !== sentences.length) throw new Error("AI did not return the correct number of visual prompts.");

    return { scenes: sentences.map((s, i) => ({ narration: s.trim(), visual_prompt: visualPrompts[i] })) };
}

async function extractKeywords(narration) {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = `From the following sentence, extract the 1 to 3 most important keywords. Return only the keywords, separated by a space.
    Sentence: "${narration}"
    Keywords:`;
    const result = await model.generateContent(prompt);
    return (await result.response).text().trim();
}

async function regenerateScriptPart(script, sceneIndex, partToRegenerate) {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const scene = script.scenes[sceneIndex];
    let prompt;
    if (partToRegenerate === 'narration') {
        prompt = `Visual: "${scene.visual_prompt}". Narration: "${scene.narration}". Generate one new, concise alternative for the narration. Return only the new text.`;
    } else {
        prompt = `Narration: "${scene.narration}". Generate one new, highly detailed visual prompt.
        CRITICAL INSTRUCTION: The new visual must be a VERTICAL 9:16 composition that fills the FULL HEIGHT of the square output frame, with black bars ONLY on the left and right (pillarboxing).
        Return only the new visual prompt text.`;
    }
    const result = await model.generateContent(prompt);
    return (await result.response).text().trim();
}

async function generateAudio(text, outputPath, voiceId) {
    await elevenlabs.textToSpeech({ fileName: outputPath, textInput: text, voiceId: voiceId });
    console.log("Audio generated successfully at", outputPath);
}

async function generateImageWithGemini(prompt, outputPath) {
    const imageModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash-image-preview" });
    const result = await imageModel.generateContent([prompt]);
    const response = await result.response;
    const imagePart = response.candidates[0].content.parts.find(p => p.inlineData);
    if (!imagePart) throw new Error("No image data found in Gemini response.");
    fs.writeFileSync(outputPath, Buffer.from(imagePart.inlineData.data, 'base64'));
    console.log("Image saved successfully to", outputPath);
}

async function assembleVideo(imagePaths, outputPath, options = {}) {
    const { narrationAudioPath, musicPath, isSilent } = options;
    
    const useCredits = SHOW_CREDITS_IMAGE && fs.existsSync(creditsImagePath);
    const creditsDuration = useCredits ? 2.5 : 0;
    
    let narrationDuration = isSilent || !narrationAudioPath
        ? imagePaths.length * 4
        : (await new Promise((res, rej) => ffmpeg.ffprobe(narrationAudioPath, (err, data) => err ? rej(err) : res(data)))).format.duration;
    
    const totalDuration = narrationDuration + creditsDuration;

    return new Promise((resolve, reject) => {
        console.log("Assembling video with FFmpeg...");
        const command = ffmpeg();
        
        // FIXED: Robust input management by grouping video and audio sources.
        const videoInputs = [...imagePaths];
        if (useCredits) videoInputs.push(creditsImagePath);

        const audioInputs = [];
        if (!isSilent && narrationAudioPath) audioInputs.push(narrationAudioPath);
        if (musicPath) audioInputs.push(musicPath);

        videoInputs.forEach(p => command.input(p).inputOptions('-loop 1'));
        audioInputs.forEach(p => command.input(p));
        
        const numImages = imagePaths.length;
        const creditsInputIndex = useCredits ? numImages : -1;
        const narrationInputIndex = (!isSilent && narrationAudioPath) ? videoInputs.length : -1;
        const musicInputIndex = musicPath ? videoInputs.length + (narrationInputIndex !== -1 ? 1 : 0) : -1;

        const imageDuration = narrationDuration / numImages;
        const transitionDuration = 0.5;
        let filterChain = [];

        imagePaths.forEach((_, i) => {
            filterChain.push(`[${i}:v]crop=ih*9/16:ih,scale=1080:1920,setsar=1[v${i}]`);
        });

        let lastStream = `v0`;
        if (numImages > 1) {
            for (let i = 1; i < numImages; i++) {
                filterChain.push(`[${lastStream}][v${i}]xfade=transition=fade:duration=${transitionDuration}:offset=${i * imageDuration - transitionDuration}[c${i}]`);
                lastStream = `c${i}`;
            }
        }
        
        let videoBaseStream = lastStream;
        
        if (useCredits) {
            filterChain.push(`[${creditsInputIndex}:v]scale=1080:1920,setsar=1[credits_v]`);
            filterChain.push(`[${videoBaseStream}][credits_v]xfade=transition=fade:duration=${transitionDuration}:offset=${narrationDuration - transitionDuration}[v_out]`);
        } else {
            filterChain.push(`[${videoBaseStream}]copy[v_out]`);
        }
        
        let audioFilter = '', audioOutputMap = '';
        if (!isSilent && musicPath) {
            audioFilter = `[${narrationInputIndex}:a]volume=1.0[narration]; [${musicInputIndex}:a]volume=0.15,atrim=0:${totalDuration}[bgm]; [narration][bgm]amix=inputs=2:duration=first[a_out]`;
            audioOutputMap = '[a_out]';
        } else if (!isSilent) {
            audioFilter = `[${narrationInputIndex}:a]copy[a_out]`;
            audioOutputMap = '[a_out]';
        } else if (musicPath) {
            audioFilter = `[${musicInputIndex}:a]volume=0.25,atrim=0:${totalDuration}[a_out]`;
            audioOutputMap = '[a_out]';
        }

        if (audioFilter) filterChain.push(audioFilter);

        command.complexFilter(filterChain.join('; '));

        const outputOptions = ['-c:v libx264', '-pix_fmt yuv420p', '-t', totalDuration, '-y'];
        command.outputOptions(audioOutputMap ? ['-map', '[v_out]', '-map', audioOutputMap, '-c:a aac', ...outputOptions] : ['-map', '[v_out]', ...outputOptions]);
        
        command
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(new Error('FFmpeg error: ' + err.message)))
            .run();
    });
}


// --- 6. API Endpoints ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/reels', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reels.html')));

app.get('/reels-list', async (req, res) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 6;
        const startIndex = (page - 1) * limit;

        const reelFolders = await fs.promises.readdir(outputDir);
        const validReels = (await Promise.all(reelFolders.map(async folder => {
            const folderPath = path.join(outputDir, folder);
            const stats = await fs.promises.stat(folderPath);
            if (!stats.isDirectory()) return null;
            
            const videoPath = path.join(folderPath, 'reel.mp4');
            const promptPath = path.join(folderPath, 'prompt.json');
            if (fs.existsSync(videoPath) && fs.existsSync(promptPath)) {
                const promptData = JSON.parse(await fs.promises.readFile(promptPath, 'utf-8'));
                return { id: folder, prompt: promptData, createdAt: stats.birthtimeMs };
            }
            return null;
        }))).filter(Boolean);

        validReels.sort((a, b) => b.createdAt - a.createdAt);
        
        res.json({
            reels: validReels.slice(startIndex, startIndex + limit),
            currentPage: page,
            totalPages: Math.ceil(validReels.length / limit)
        });
    } catch (error) { res.status(500).json({ error: "Failed to list reels." }); }
});

app.get('/music', (req, res) => {
    fs.readdir(musicDir, (err, files) => {
        if (err) return res.status(500).json({ error: 'Could not read music directory.' });
        res.json(files.filter(f => f.endsWith('.mp3')));
    });
});

app.get('/templates', (req, res) => {
    fs.readdir(templatesDir, (err, files) => {
        if (err) return res.status(500).json({ error: 'Could not read templates directory.' });
        res.json(files.filter(f => f.endsWith('.json')).map(f => ({
            id: path.basename(f, '.json'),
            name: JSON.parse(fs.readFileSync(path.join(templatesDir, f), 'utf-8')).name
        })));
    });
});

app.get('/reel/:folderName', (req, res) => {
    const { folderName } = req.params;
    if (!/^\d+$/.test(folderName)) return res.status(400).send('Invalid Reel ID format.');
    const videoPath = path.join(__dirname, 'outputs', folderName, 'reel.mp4');
    fs.access(videoPath, fs.constants.F_OK, (err) => err ? res.status(404).send('Reel not found.') : res.sendFile(videoPath));
});

app.post('/generate-script', async (req, res) => {
    try {
        const { text, templateId, keepNarration } = req.body;
        if (!text) return res.status(400).json({ error: 'Input text is required.' });
        let script;
        if (keepNarration) {
            script = await splitTextToScript(text);
        } else {
            const templatePath = path.join(templatesDir, `${templateId}.json`);
            if (!fs.existsSync(templatePath)) return res.status(400).json({ error: 'Template not found.' });
            const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
            script = await generateScript(text, template);
        }
        res.json(script);
    } catch (error) { handleGoogleAIError(error, res); }
});

app.post('/regenerate-part', async (req, res) => {
    try {
        const { script, sceneIndex, part } = req.body;
        const newText = await regenerateScriptPart(script, sceneIndex, part);
        res.json({ newText });
    } catch (error) { handleGoogleAIError(error, res); }
});

app.post('/create-video', async (req, res) => {
    try {
        let { script, musicFile, overlayText, voiceId, originalText, templateId } = req.body;
        const uniqueId = Date.now().toString();
        const requestDir = path.join(outputDir, uniqueId);
        fs.mkdirSync(requestDir, { recursive: true });

        const isSilent = !voiceId || voiceId === 'none';
        let narrationAudioPath = null;
        if (!isSilent) {
            const fullNarration = script.scenes.map(s => s.narration).join(' ');
            narrationAudioPath = path.join(requestDir, 'audio.mp3');
            await generateAudio(fullNarration, narrationAudioPath, voiceId);
        }
        
        const imagePaths = await Promise.all(
            script.scenes.map(async (scene, i) => {
                const imagePath = path.join(requestDir, `image_${i}.png`);
                let finalImagePrompt = addPillarboxInstruction(scene.visual_prompt);

                if (overlayText) { 
                    const keywords = await extractKeywords(scene.narration);
                    if (keywords) {
                        finalImagePrompt += ` The text "${keywords.toUpperCase()}" is rendered on the image. CRITICAL: This square image will be programmatically center-cropped into a tall 9:16 video frame, cutting off the left and right sides. To ensure the text is not cropped, you MUST render it in a compact, multi-line block if necessary, and keep it strictly within the central vertical third of the image. The text must be far from the left and right edges.`;
                    }
                }
                return generateImageWithGemini(finalImagePrompt, imagePath).then(() => imagePath);
            })
        );
        
        const musicPath = musicFile && fs.existsSync(path.join(musicDir, musicFile)) ? path.join(musicDir, musicFile) : null;
        const videoPath = path.join(requestDir, 'reel.mp4');
        await assembleVideo(imagePaths, videoPath, { narrationAudioPath, musicPath, isSilent });

        const promptDetails = { originalText, templateId, voiceId, musicFile, overlayText, finalScript: script };
        await fs.promises.writeFile(path.join(requestDir, 'prompt.json'), JSON.stringify(promptDetails, null, 2));

        res.json({ videoUrl: `/outputs/${uniqueId}/reel.mp4` });
    } catch (error) { handleGoogleAIError(error, res); }
});

// --- 7. Start Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

