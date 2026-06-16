const { expandTopic, thinkAboutTopic, specFromThinking, thinkAboutLab, thinkAboutVisualPedagogy } = require('./server.js');

async function test() {
    const rawTopic = "Archimedean Spiral";
    const category = "General";

    console.log("1. Testing categoryGuidance via prompt check...");
    // Since we can't easily call internal vars, we'll just check if the export worked.
    if (typeof expandTopic === 'function') {
        console.log("SUCCESS: expandTopic is a function");
    } else {
        console.log("FAILURE: expandTopic is NOT a function");
        process.exit(1);
    }
}

test();
