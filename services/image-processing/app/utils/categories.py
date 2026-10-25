import modal
import os
import numpy as np

# ------------------------------------------------------------------------------
# 1. CONFIGURATION
# ------------------------------------------------------------------------------
MODEL_NAME = "ViT-L-14"
PRETRAINED = "laion2b_s32b_b82k"

image = (
    modal.Image.debian_slim()
    .pip_install("open_clip_torch", "torch", "numpy")
    .run_commands(
        f"python -c 'import open_clip; open_clip.create_model_and_transforms(\"{MODEL_NAME}\", pretrained=\"{PRETRAINED}\")'"
    )
)

app = modal.App("vit-l14-text-indexer")
vol = modal.Volume.from_name("vit-l14-results", create_if_missing=True)

# ------------------------------------------------------------------------------
# 2. REMOTE FUNCTION
# ------------------------------------------------------------------------------
@app.function(
    image=image,
    gpu="T4",
    volumes={"/root/output": vol},
    timeout=600
)
def generate_text_embeddings():
    import torch
    import torch.nn.functional as F
    import open_clip
    import os

    print(f"⚙️  Setting up {MODEL_NAME} on GPU...")
    device = "cuda" if torch.cuda.is_available() else "cpu"

    try:
        model, _, preprocess = open_clip.create_model_and_transforms(MODEL_NAME, pretrained=PRETRAINED)
        tokenizer = open_clip.get_tokenizer(MODEL_NAME)
    except Exception as e:
        print(f"❌ Error loading model: {e}")
        model, _, preprocess = open_clip.create_model_and_transforms(MODEL_NAME, pretrained='openai')
        tokenizer = open_clip.get_tokenizer(MODEL_NAME)

    model.to(device).eval()

    # --------------------------------------------------------------------------
    # CATEGORY CONCEPT DESIGN PRINCIPLES:
    #
    # 1. SPECIFICITY — Each concept names exactly what makes this category unique.
    #    Avoid generic words shared across categories (e.g., "image of", "photo of"
    #    alone is not enough — add discriminative details).
    #
    # 2. NO OVERLAP — Categories with natural confusion (pfp vs anime vs people)
    #    are separated by anchoring on FORMAT (circular crop, framed portrait),
    #    MEDIUM (photograph, drawing, render), and SUBJECT (real human, 2D character).
    #
    # 3. COVERAGE — Multiple facets per category so one-shot embeddings cover
    #    the full distribution: style variants, sub-genres, common real-world forms.
    #
    # 4. NEGATIVE ANCHORING via specificity — Prompts are written so the concept
    #    itself is discriminative. "anime-style circular profile picture" belongs to
    #    pfp, NOT anime, because the format signal (circular avatar) dominates.
    # --------------------------------------------------------------------------

    CATEGORY_CONCEPTS = {

        # FORMAT: circular/square crop, small icon, used as social identity
        # MEDIUM: any (real photo, illustration, 3D, pixel art)
        # SUBJECT: face or avatar centered in frame — NOT the art style
        "pfp": [
            "circular cropped profile picture used as a social media avatar",
            "square avatar icon with a face centered in frame",
            "discord profile picture with a character portrait",
            "small social media icon showing a headshot or avatar",
            "profile photo thumbnail with tight face crop",
            "gaming username avatar with a character face",
            "round icon avatar used for online identity",
            "profile picture with solid or blurred background behind a face",
        ],

        # MEDIUM: 2D hand-drawn or cell-shaded Japanese animation art
        # SUBJECT: anime characters, manga panels, Japanese animated scenes
        # NOT: profile pictures, western cartoons, or real people
        "anime": [
            "Japanese anime art style with expressive eyes and colorful hair",
            "manga panel with black and white ink line art",
            "cel shaded anime character with large eyes and stylized features",
            "anime key visual with dramatic lighting and vibrant colors",
            "studio Ghibli style painted background with soft watercolor look",
            "shounen anime fight scene with speed lines and action",
            "anime girl with pastel hair and school uniform",
            "anime landscape with torii gate cherry blossoms and soft sky",
        ],

        # MEDIUM: real-world photograph (camera or phone)
        # SUBJECT: actual human being — face, body, portrait
        # NOT: drawn characters, anime, avatars, cosplay
        "people": [
            "real photograph of a human face taken with a camera",
            "candid street photography of a person walking",
            "studio portrait photo of a real person with professional lighting",
            "selfie photograph showing a real human face",
            "group photo of real people at an event",
            "close-up photo of a person's face with natural lighting",
            "documentary photograph of a real individual",
            "photo of a person in everyday clothes in a real environment",
        ],

        # MEDIUM: traditional or digital fine art — paintings, illustrations, concept art
        # SUBJECT: non-character creative artwork — abstract, landscape, still life
        # NOT: anime, cartoons, or photographs
        "arts": [
            "oil painting with visible brushstrokes and rich texture",
            "abstract digital artwork with geometric shapes and vibrant color",
            "concept art environment painting for a video game or film",
            "watercolor painting with soft washes and natural subjects",
            "impressionist landscape painting with loose brushwork",
            "classical portrait painting in renaissance style",
            "surrealist fine art painting with dreamlike imagery",
            "detailed illustration artwork with intricate linework and color",
        ],

        # SUBJECT: superheroes from comics, films, or cosplay
        # KEY SIGNALS: cape, mask, logo on chest, comic panel style, spandex suit
        # NOT: generic fantasy characters or anime heroes
        "superheroes": [
            "Marvel comics superhero in a colorful spandex suit with logo",
            "DC comics character like Batman or Superman in iconic costume",
            "superhero wearing a cape and mask flying over a city",
            "comic book panel showing a caped hero in action",
            "cosplay of a superhero with accurate costume and props",
            "superhero movie promotional still with a caped character",
            "Spider-Man in red and blue suit swinging between buildings",
            "Iron Man in metal suit with glowing chest reactor",
        ],

        # SUBJECT: natural landscapes and outdoor environments
        # MEDIUM: real photographs of nature without people as main subject
        # NOT: space, animals in isolation, or urban scenes
        "nature": [
            "landscape photograph of a mountain range with clear sky",
            "dense forest photography with sunlight filtering through trees",
            "aerial photo of a river winding through green valleys",
            "nature photograph of a waterfall surrounded by rocks and moss",
            "wide shot of a desert with sand dunes at golden hour",
            "photo of a meadow full of wildflowers in summer",
            "autumn forest path covered in fallen orange and red leaves",
            "panoramic coastal cliff photograph with crashing ocean waves",
        ],

        # SUBJECT: outer space, astronomy, cosmos, NASA imagery
        # MEDIUM: telescope photos, rendered space scenes, astronaut photos
        # NOT: night sky from Earth with landscape, abstract art
        "space": [
            "Hubble Space Telescope photograph of a distant galaxy",
            "NASA photo of planet Earth taken from outer space",
            "astronaut in spacesuit floating outside the International Space Station",
            "photograph of the Milky Way galaxy with stars and nebula",
            "rendered image of a spacecraft flying past a planet",
            "close-up photo of the surface of the Moon with craters",
            "colorful nebula with glowing gas clouds and bright stars",
            "Mars surface photograph taken by a rover",
        ],

        # SUBJECT: animals as the clear main focus of the image
        # MEDIUM: real photography or highly realistic renders
        # NOT: cartoon animals, pets drawn as illustrations, nature landscapes
        "animals": [
            "close-up wildlife photograph of a lion in natural habitat",
            "photo of a dog sitting and looking at the camera",
            "cat portrait photograph with sharp focus on the face",
            "wildlife photographer shot of a bird in mid-flight",
            "underwater photography of tropical fish near coral reef",
            "macro photograph of an insect on a leaf",
            "zoo photograph of an elephant with detailed skin texture",
            "realistic photo of a horse running in an open field",
        ],

        # SUBJECT: motorized vehicles as the main focus
        # MEDIUM: real photograph or highly realistic render
        # NOT: toy vehicles, cartoon cars, spacecraft
        "vehicles": [
            "sports car on a winding mountain road photographed from outside",
            "motorcycle racing on a track leaning into a curve",
            "commercial airplane in flight against a blue sky",
            "passenger train on tracks through a countryside landscape",
            "truck on a highway at night with headlights on",
            "military fighter jet photographed from below in flight",
            "classic vintage car parked on a city street",
            "speedboat racing across open water creating a large wake",
        ],

        # MEDIUM: western 2D cartoon animation — flat, vector, or painted
        # SUBJECT: cartoon characters or animated scenes from western studios
        # NOT: anime, 3D CGI films, or comic book panels
        "cartoon": [
            "western cartoon character with exaggerated proportions and flat color fills",
            "Disney animation style character with smooth linework and expressive face",
            "Cartoon Network style character with bold outlines and simple shapes",
            "flat vector illustration of a cartoon character with minimal shading",
            "Nickelodeon cartoon style with rubbery limbs and bright colors",
            "classic 1950s Looney Tunes style cartoon character",
            "childrens book illustration with friendly cartoon characters",
            "comic strip cartoon with simple drawings and speech bubbles",
        ],

        # SUBJECT: inanimate objects, technology, everyday items
        # MEDIUM: real product photography or still life
        # NOT: food, vehicles, artworks
        "objects": [
            "product photography of a smartphone on a white background",
            "desk setup with a computer monitor keyboard and mouse",
            "still life photograph of a book and glasses on a table",
            "commercial product shot of headphones with clean lighting",
            "photograph of a coffee mug on a wooden table",
            "flat lay photo of everyday items arranged on a surface",
            "packaged product on a retail shelf with visible label",
            "close-up photo of a mechanical watch showing the dial",
        ],

        # SUBJECT: food and beverages as the main focus
        # MEDIUM: real food photography, styled plating, restaurant shots
        # NOT: people eating, abstract art, kitchen tools without food
        "food": [
            "restaurant meal plated on a white dish with garnishes",
            "close-up food photography of a fresh dessert with sauce drizzle",
            "overhead flat lay of a breakfast spread with various dishes",
            "street food photograph with steam rising from a hot dish",
            "fresh fruit and vegetables arranged in a colorful composition",
            "Ghibli style illustrated food scene with warm cozy lighting",
            "sushi platter photographed from above with soy sauce and wasabi",
            "pizza with melted cheese photographed in a restaurant setting",
        ],

        # SUBJECT: religious or divine figures and iconography
        # MEDIUM: paintings, statues, illustrations, or symbolic imagery
        # NOT: regular people, fantasy characters without religious context
        "gods": [
            "Hindu deity statue with multiple arms and ornate crown",
            "classical painting of Jesus Christ with halo and robes",
            "Greek mythology god illustration with divine symbols",
            "ancient Egyptian god figure with animal head and hieroglyphs",
            "Buddhist deity sculpture with serene expression and lotus throne",
            "religious icon painting of a saint with golden halo",
            "Norse mythology god depicted in illustrated epic scene",
            "sacred spiritual figure surrounded by divine light or aura",
        ],

        # SUBJECT: cinema — film scenes, posters, or promotional stills
        # MEDIUM: official movie posters, film screenshots, or promotional photos
        # NOT: TV shows, anime films, or regular people in a photo
        "movie": [
            "official Hollywood movie poster with title and cast billing",
            "dramatic film still from a cinematic scene with actors",
            "movie promotional image with cinematic color grading",
            "action movie scene with two actors in an intense confrontation",
            "romantic movie still with two leads in a dramatic location",
            "horror movie poster with dark atmospheric typography",
            "science fiction film scene with futuristic set and costumes",
            "behind the scenes photo from a major film production set",
        ],
    }

    # --------------------------------------------------------------------------
    # TEMPLATES: Cover multiple phrasings so the mean embedding is robust.
    # Using 3 lightweight templates — enough variety without diluting specificity.
    # --------------------------------------------------------------------------
    TEMPLATES = [
        lambda c: f"{c}",
        lambda c: f"a photo of {c}.",
        lambda c: f"an image showing {c}.",
    ]

    print(f"\n🧠 Generating Embeddings for {len(CATEGORY_CONCEPTS)} categories...")

    final_embeddings = []
    category_names_list = []

    with torch.no_grad():
        for category_key, concepts in CATEGORY_CONCEPTS.items():
            category_names_list.append(category_key)
            prompts = [tmpl(c) for c in concepts for tmpl in TEMPLATES]

            # Encode all prompts
            text_tokens = tokenizer(prompts).to(device)
            embeddings = model.encode_text(text_tokens)

            # L2-normalize each embedding
            embeddings = F.normalize(embeddings, p=2, dim=-1)

            # Average across all prompts for this category
            mean_embedding = embeddings.mean(dim=0)

            # Normalize the mean embedding
            mean_embedding = F.normalize(mean_embedding, p=2, dim=0)

            final_embeddings.append(mean_embedding)
            print(f"   ✅ {category_key} ({len(prompts)} prompts)")

    # Stack all category embeddings
    text_embeddings_np = torch.stack(final_embeddings).cpu().numpy()

    # Save to Volume
    os.makedirs("/root/output", exist_ok=True)
    np.save("/root/output/category_embeddings.npy", text_embeddings_np)
    np.save("/root/output/category_names.npy", np.array(category_names_list))

    vol.commit()
    print(f"\n💾 Saved to Volume! Shape: {text_embeddings_np.shape}")
    return text_embeddings_np.shape


# ------------------------------------------------------------------------------
# 3. LOCAL ENTRYPOINT
# ------------------------------------------------------------------------------
@app.local_entrypoint()
def main():
    print("🚀 Starting Text Embedding Generation on Modal...")

    shape = generate_text_embeddings.remote()
    print(f"✅ Remote generation complete. Shape: {shape}")

    print("\n📥 Downloading files to local 'embeddings' folder...")
    os.makedirs("embeddings", exist_ok=True)

    files_to_download = ["category_embeddings.npy", "category_names.npy"]

    try:
        for fname in files_to_download:
            with open(f"embeddings/{fname}", "wb") as f:
                for chunk in vol.read_file(f"{fname}"):
                    f.write(chunk)
            print(f"   - Downloaded {fname}")

        print("🎉 Done! Files are in your local 'embeddings' folder.")

    except Exception as e:
        print(f"❌ Error downloading files: {e}")