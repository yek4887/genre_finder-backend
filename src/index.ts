// server/src/index.ts
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import SpotifyWebApi from 'spotify-web-api-node';
import 'dotenv/config';

// @ts-ignore
import { TrackObjectFull } from 'spotify-web-api-node-ts/src/types/SpotifyObjects';

const app = express();

const allowedOrigins = ['https://genrefinder.xyz'];
const corsOptions: cors.CorsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${origin} not allowed by CORS`)); // 에러 메시지 구체화
    }
  },
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const isProduction = process.env.NODE_ENV === 'production';
const redirectUri = isProduction
  ? `${process.env.BACKEND_URL}/api/callback`
  : 'http://127.0.0.1:8080/api/callback';

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: redirectUri
});

app.get('/api/login', (req, res) => { /* ... 이전과 동일 ... */ });
app.get('/api/callback', async (req, res) => { /* ... 이전과 동일 ... */ });

app.post('/api/recommend-genres', async (req, res) => {
  const { query, accessToken } = req.body;
  console.log(`[${new Date().toISOString()}] Received recommend-genres request for query: ${query}`); // 요청 시작 로그

  if (!query) {
      console.warn("Query is missing");
      return res.status(400).json({ error: 'Query is required' });
  }
  if (!accessToken) {
      console.warn("Access Token is missing");
      return res.status(401).json({ error: 'Access Token is required'});
  }

  const userSpotifyApi = new SpotifyWebApi({ accessToken });

  try {
    let artist: any = null;
    let searchStep = 'Initial'; // 디버깅을 위한 단계 변수

    try {
      searchStep = 'Searching tracks';
      console.log(`Searching tracks for: ${query}`);
      const trackSearch = await userSpotifyApi.searchTracks(query, { limit: 1 });
      if (trackSearch.body.tracks && trackSearch.body.tracks.items.length > 0) {
        searchStep = 'Getting artist from track';
        const trackArtistId = trackSearch.body.tracks.items[0].artists[0].id;
        console.log(`Found track, getting artist ID: ${trackArtistId}`);
        const artistResponse = await userSpotifyApi.getArtist(trackArtistId);
        artist = artistResponse.body;
      } else {
        searchStep = 'Searching artists';
        console.log(`Track not found, searching artists for: ${query}`);
        const artistSearch = await userSpotifyApi.searchArtists(query, { limit: 1 });
        if (artistSearch.body.artists && artistSearch.body.artists.items.length > 0) {
          artist = artistSearch.body.artists.items[0];
        }
      }
    } catch (spotifySearchError) {
        console.error(`Error during Spotify search (${searchStep}):`, spotifySearchError);
        // Spotify 검색 오류 시에도 500 대신 좀 더 구체적인 오류 반환 시도
        return res.status(503).json({ error: 'Failed to search Spotify. Please try again later.' });
    }


    if (!artist) {
      console.log(`Artist or Track not found for query: ${query}`);
      return res.status(404).json({ error: 'Artist or Track not found' });
    }
    console.log(`Found artist: ${artist.name}`);

    let topTracks: any[] = [];
    try {
        console.log(`Getting top tracks for artist ID: ${artist.id}`);
        const topTracksResponse = await userSpotifyApi.getArtistTopTracks(artist.id, 'US');
        topTracks = topTracksResponse.body.tracks.slice(0, 5).map(track => ({
            name: track.name,
            url: track.external_urls.spotify,
            preview_url: track.preview_url
        }));
    } catch (topTrackError) {
        console.error(`Error getting top tracks for ${artist.name}:`, topTrackError);
        // 대표곡 조회 실패는 치명적이지 않으므로, 빈 배열로 계속 진행
    }


    const existingGenres = (artist.genres && artist.genres.length > 0)
      ? `Do not recommend the genre "${artist.genres.join(', ')}".`
      : '';

    const prompt = `...`; // (프롬프트 내용은 이전과 동일)

    let aiGenres: any[] = []; // 기본값 빈 배열
    try {
        console.log(`Sending request to OpenAI for artist: ${artist.name}`);
        const completion = await openai.chat.completions.create({
          model: "gpt-3.5-turbo",
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
        });

        const aiResponse = completion.choices[0].message.content;
        if (aiResponse) {
            try {
                aiGenres = JSON.parse(aiResponse).genres || [];
                 console.log(`Received AI genres for ${artist.name}`);
            } catch (parseError) {
                console.error("Failed to parse AI response JSON:", parseError, "Response was:", aiResponse);
                // 파싱 실패 시에도 빈 배열 유지
            }
        } else {
            console.warn(`OpenAI returned empty content for ${artist.name}`);
        }
    } catch (openaiError) {
        console.error(`Error calling OpenAI for ${artist.name}:`, openaiError);
        // OpenAI 오류 시에도 빈 배열 유지, 서비스 중단 방지
    }


    let enrichedGenres: any[] = [];
    try {
        console.log(`Fetching images for AI recommended artists...`);
        enrichedGenres = await Promise.all(
          (aiGenres || []).map(async (genre: any) => {
            let imageUrl: string | null = null;
            try {
              if (genre && genre.artists && genre.artists.length > 0 && genre.artists[0].artistName) {
                const artistSearch = await userSpotifyApi.searchArtists(genre.artists[0].artistName, { limit: 1 });
                if (artistSearch.body.artists && artistSearch.body.artists.items.length > 0) {
                  imageUrl = artistSearch.body.artists.items[0].images[0]?.url || null;
                }
              }
            } catch (imageError) {
                console.error(`Failed to fetch image for ${genre.artists[0]?.artistName}:`, imageError);
            }
            return { ...genre, imageUrl };
          })
        );
         console.log(`Finished fetching images.`);
    } catch (enrichError) {
        console.error("Error during genre enrichment (image fetching):", enrichError);
        enrichedGenres = aiGenres; // 이미지 조회가 실패하면 원본 AI 결과 사용
    }


    const responseData = {
      searchedArtist: { name: artist.name, imageUrl: artist.images[0]?.url },
      topTracks: topTracks,
      aiRecommendations: enrichedGenres,
    };

    console.log(`Successfully processed request for query: ${query}`);
    res.json(responseData);

  } catch (error) {
    // 예상치 못한 모든 오류 처리
    console.error(`Unhandled error processing request for query ${query}:`, error);
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
});

app.post('/api/save-playlist', async (req, res) => { /* ... 이전과 동일 ... */ });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => { /* ... 이전과 동일 ... */ });